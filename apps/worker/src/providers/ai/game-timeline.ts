import type { ModelTokenUsage } from "@clipforge/shared";
import { computeModelCostUsd, classifyModelTier } from "@clipforge/shared";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { runFfmpegBinary } from "../../lib/ffmpeg.js";
import { getAnthropicClient, cachedSystemPrompt, readCacheUsage, toolChoiceFor } from "./anthropic-client.js";
import { logger } from "../../lib/logger.js";

/**
 * Quali giochi ci sono in un video long-form, e quando, GUARDANDO LO SCHERMO (non il titolo né la
 * trascrizione). Chiesto da simo il 2026-09-28: in una clip di un'ora possono esserci 2-3 giochi, e
 * lui vuole scegliere quale tenere nel video montato. Serve anche ai tagli: dalla sola trascrizione
 * il taglio sul cambio di gioco sbagliava (su COD l'AI ha scelto una frase detta 30 s dopo l'inizio
 * del cruciverba, e un altro taglio toglieva l'ultimo round e la vittoria).
 *
 * 1. Un fotogramma ogni SAMPLE_SECONDS: l'AI dice cosa c'è a schermo e raggruppa in tratti.
 * 2. Su ogni cambio, fotogrammi ogni REFINE_SECONDS fra i due campioni: l'AI dice dove cambia.
 * Costo misurato su un'ora di COD (2026-09-28): 0,063 $ con Sonnet 5 a 30 s e 400 px. simo: "meglio dimezzarlo",
 * quindi 45 s, rifinitura ogni 4 s e fotogrammi da 320 px (~0,4 dei token: ~2-3 centesimi l'ora).
 */

export type GameSegmentKind = "gioco" | "ruota" | "altro";

export interface GameSegment {
  /** Secondi dall'inizio della clip. */
  start: number;
  end: number;
  kind: GameSegmentKind;
  /** Nome del gioco ("Call of Duty: Black Ops 7"), "Ruota", o "Altro". */
  name: string;
  /** Solo per "altro": cosa c'è (chiacchiere, desktop, cruciverba nel browser...). */
  what?: string;
}

const SAMPLE_SECONDS = 45;
const REFINE_SECONDS = 4;
/** L'API accetta al massimo 100 immagini per richiesta. */
const MAX_FRAMES_PER_CALL = 80;
const FRAME_WIDTH = 320;

const TOOL_NAME = "mappa_giochi";
const REFINE_TOOL = "punti_di_cambio";

const SYSTEM_PROMPT = `Guardi i fotogrammi di una live Twitch italiana (streamer come Blur, Marza, Pesh in call fra loro, con le webcam sovrapposte al gioco). Devi dire cosa c'è A SCHERMO in ogni momento, per dividere il video per gioco.

Per ogni tratto indica:
- kind "gioco": si sta giocando a un gioco. "name" è il nome del gioco, sempre scritto uguale (es. "Call of Duty: Black Ops 7", "Fall Guys", "Rocket League"). Anche menu, lobby, caricamenti, classifiche e schermate di vittoria/sconfitta DI QUEL GIOCO sono quel gioco.
- kind "ruota": la ruota che sceglie il prossimo gioco (ruota colorata tipo "Wheel of Names"). "name" = "Ruota".
- kind "altro": tutto il resto (solo webcam, desktop, browser, cruciverba o quiz nel browser, video, chat). "name" = "Altro", e in "what" scrivi cosa c'è in 2-5 parole.
Riconosci il gioco da quello che si vede (logo, interfaccia, grafica), NON inventare: se non lo riconosci scrivi quello che è (es. "Gioco di corse sconosciuto").

Raggruppa i fotogrammi consecutivi uguali in tratti. Un fotogramma nero o di transizione in mezzo allo stesso gioco fa parte di quel gioco.`;

const REFINE_PROMPT = `Guardi i fotogrammi di una live Twitch italiana, a pochi secondi l'uno dall'altro, attorno ad alcuni punti in cui cambia quello che c'è a schermo (da un gioco a un altro, alla ruota che sceglie il gioco, o a tutt'altro). Per ogni punto di cambio ti dico cosa c'era prima e cosa c'è dopo: dimmi il numero del PRIMO fotogramma in cui si vede già quello che c'è dopo. Menu, caricamenti e schermate di fine partita di un gioco fanno parte di quel gioco.`;

const segmentSchema = z.object({
  fromFrame: z.coerce.number().int(),
  toFrame: z.coerce.number().int(),
  kind: z.enum(["gioco", "ruota", "altro"]).catch("altro"),
  name: z.string(),
  what: z.string().optional(),
});

function parseJsonText(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const mapSchema = z.object({ segments: z.preprocess(parseJsonText, z.array(z.preprocess(parseJsonText, segmentSchema))) });
const refineSchema = z.object({
  changes: z.preprocess(parseJsonText, z.array(z.preprocess(parseJsonText, z.object({ change: z.coerce.number().int(), firstFrame: z.coerce.number().int() })))),
});

const MAP_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: "Restituisce i tratti del video con cosa c'è a schermo.",
  input_schema: {
    type: "object",
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fromFrame: { type: "integer", description: "Numero del primo fotogramma del tratto." },
            toFrame: { type: "integer", description: "Numero dell'ultimo fotogramma del tratto." },
            kind: { type: "string", enum: ["gioco", "ruota", "altro"] },
            name: { type: "string" },
            what: { type: "string" },
          },
          required: ["fromFrame", "toFrame", "kind", "name"],
        },
      },
    },
    required: ["segments"],
  },
};

const REFINE_TOOL_SCHEMA: Anthropic.Tool = {
  name: REFINE_TOOL,
  description: "Per ogni punto di cambio, il primo fotogramma in cui si vede già quello che viene dopo.",
  input_schema: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: { change: { type: "integer" }, firstFrame: { type: "integer" } },
          required: ["change", "firstFrame"],
        },
      },
    },
    required: ["changes"],
  },
};

async function frameJpeg(videoPath: string, t: number): Promise<string | null> {
  try {
    const buffer = await runFfmpegBinary(
      ["-ss", t.toFixed(2), "-i", videoPath, "-frames:v", "1", "-vf", `scale=${FRAME_WIDTH}:-2`, "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
      { timeoutMs: 30 * 1000 },
    );
    return buffer.length > 0 ? buffer.toString("base64") : null;
  } catch {
    return null;
  }
}

/** Fotogrammi ai tempi dati (4 alla volta), saltando quelli che non si estraggono. */
async function frames(videoPath: string, times: number[]): Promise<Array<{ t: number; jpeg: string }>> {
  const out: Array<{ t: number; jpeg: string } | null> = [];
  for (let i = 0; i < times.length; i += 4) {
    const batch = await Promise.all(times.slice(i, i + 4).map(async (t) => ({ t, jpeg: await frameJpeg(videoPath, t) })));
    out.push(...batch.map((b) => (b.jpeg ? { t: b.t, jpeg: b.jpeg } : null)));
  }
  return out.filter((x): x is { t: number; jpeg: string } => x !== null);
}

/**
 * Mappa dei giochi di una clip (tempi in secondi dall'inizio della clip), o null se fallisce.
 * `start`/`end` sono i secondi della clip nel sorgente.
 */
export async function detectGameTimeline(
  input: { sourceVideoPath: string; start: number; end: number },
  options: { apiKey: string; model: string },
): Promise<GameSegment[] | null> {
  const duration = input.end - input.start;
  const usage: ModelTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  const client = getAnthropicClient(options.apiKey);
  const track = (message: Anthropic.Message) => {
    usage.calls++;
    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    const cache = readCacheUsage(message.usage);
    usage.cacheRead += cache.cacheRead;
    usage.cacheWrite += cache.cacheWrite;
  };
  try {
    // 1. Mappa grossolana
    const times: number[] = [];
    for (let t = 2; t < duration - 1; t += SAMPLE_SECONDS) times.push(t);
    const sampled = await frames(input.sourceVideoPath, times.map((t) => input.start + t));
    if (sampled.length < 2) return null;
    const labels: Array<{ kind: GameSegmentKind; name: string; what?: string } | undefined> = new Array(sampled.length);
    let known: string[] = [];
    for (let from = 0; from < sampled.length; from += MAX_FRAMES_PER_CALL) {
      const chunk = sampled.slice(from, from + MAX_FRAMES_PER_CALL);
      const content: Exclude<Anthropic.MessageParam["content"], string> = [];
      if (known.length) content.push({ type: "text", text: `Nomi già usati nella parte prima (riusali uguali se è lo stesso gioco): ${known.join(", ")}` });
      chunk.forEach((f, k) => {
        content.push({ type: "text", text: `Fotogramma ${from + k} (minuto ${((f.t - input.start) / 60).toFixed(1)}):` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpeg } });
      });
      const message = await client.messages.create({
        model: options.model,
        max_tokens: 4000,
        system: cachedSystemPrompt(SYSTEM_PROMPT),
        messages: [{ role: "user", content }],
        tools: [MAP_TOOL],
        tool_choice: toolChoiceFor(options.model, TOOL_NAME),
      });
      track(message);
      const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME);
      const parsed = toolUse ? mapSchema.safeParse(toolUse.input) : null;
      if (!parsed?.success) {
        logger.warn("Mappa dei giochi: risposta illeggibile", { input: toolUse ? JSON.stringify(toolUse.input).slice(0, 400) : null });
        return null;
      }
      for (const seg of parsed.data.segments) {
        for (let i = Math.max(seg.fromFrame, from); i <= Math.min(seg.toFrame, from + chunk.length - 1); i++) {
          labels[i] = { kind: seg.kind, name: seg.kind === "ruota" ? "Ruota" : seg.kind === "altro" ? "Altro" : seg.name.trim(), what: seg.what };
        }
      }
      known = [...new Set(labels.filter((l) => l?.kind === "gioco").map((l) => l!.name))];
    }
    // Un fotogramma senza etichetta prende quella di prima (o di dopo).
    for (let i = 0; i < labels.length; i++) labels[i] ??= labels[i - 1] ?? labels.slice(i).find(Boolean) ?? { kind: "altro", name: "Altro" };

    // Tratti grossolani: si cambia a metà fra due campioni diversi, poi si rifinisce.
    const rough: Array<GameSegment & { lastSample: number; firstSample: number }> = [];
    sampled.forEach((f, i) => {
      const l = labels[i]!;
      const t = f.t - input.start;
      const last = rough[rough.length - 1];
      if (last && last.kind === l.kind && last.name === l.name) {
        last.lastSample = t;
      } else {
        rough.push({ start: t, end: t, kind: l.kind, name: l.name, what: l.what, firstSample: t, lastSample: t });
      }
    });

    // 2. Rifinitura dei cambi: fotogrammi fitti fra l'ultimo campione del tratto e il primo del successivo.
    const cuts: number[] = [];
    const refineContent: Exclude<Anthropic.MessageParam["content"], string> = [];
    let frameNo = 0;
    const refineFrames: Array<{ change: number; t: number; no: number }> = [];
    for (let c = 1; c < rough.length; c++) {
      const a = rough[c - 1]!;
      const b = rough[c]!;
      cuts.push((a.lastSample + b.firstSample) / 2);
      const ts: number[] = [];
      for (let t = a.lastSample + REFINE_SECONDS; t < b.firstSample; t += REFINE_SECONDS) ts.push(t);
      const got = await frames(input.sourceVideoPath, ts.map((t) => input.start + t));
      if (got.length === 0) continue;
      refineContent.push({ type: "text", text: `Punto di cambio ${c}: prima "${a.name}${a.what ? ` (${a.what})` : ""}", dopo "${b.name}${b.what ? ` (${b.what})` : ""}".` });
      for (const f of got) {
        refineFrames.push({ change: c, t: f.t - input.start, no: frameNo });
        refineContent.push({ type: "text", text: `Fotogramma ${frameNo}:` });
        refineContent.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.jpeg } });
        frameNo++;
      }
    }
    if (refineFrames.length > 0 && refineFrames.length <= 95) {
      const message = await client.messages.create({
        model: options.model,
        max_tokens: 2000,
        system: cachedSystemPrompt(REFINE_PROMPT),
        messages: [{ role: "user", content: refineContent }],
        tools: [REFINE_TOOL_SCHEMA],
        tool_choice: toolChoiceFor(options.model, REFINE_TOOL),
      });
      track(message);
      const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === REFINE_TOOL);
      const parsed = toolUse ? refineSchema.safeParse(toolUse.input) : null;
      if (parsed?.success) {
        for (const ch of parsed.data.changes) {
          const f = refineFrames.find((x) => x.no === ch.firstFrame && x.change === ch.change);
          if (f) cuts[ch.change - 1] = f.t - REFINE_SECONDS / 2;
        }
      }
    }

    const timeline: GameSegment[] = rough.map((r, i) => ({
      start: i === 0 ? 0 : cuts[i - 1]!,
      end: i === rough.length - 1 ? duration : cuts[i]!,
      kind: r.kind,
      name: r.name,
      ...(r.what ? { what: r.what } : {}),
    }));
    logger.info("Mappa dei giochi", {
      tratti: timeline.map((s) => `${(s.start / 60).toFixed(1)}-${(s.end / 60).toFixed(1)} min ${s.name}${s.what ? ` (${s.what})` : ""}`),
    });
    return timeline;
  } catch (error) {
    logger.warn("Mappa dei giochi fallita", { error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    const tier = classifyModelTier(options.model) ?? "sonnet";
    if (usage.calls > 0) logger.info("Costo REALE misurato — mappa dei giochi", { model: options.model, ...usage, costUsd: computeModelCostUsd(tier, usage).toFixed(4) });
  }
}

/** Il gioco da tenere se simo non ha scelto: quello che dura di più. */
export function mainGame(timeline: GameSegment[]): string | null {
  const totals = new Map<string, number>();
  for (const s of timeline) if (s.kind === "gioco") totals.set(s.name, (totals.get(s.name) ?? 0) + (s.end - s.start));
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Le parti da tenere per i giochi scelti: i loro tratti, più la ruota subito prima (la ruota che
 * sceglie quel gioco resta sempre, vedi le regole di simo sui VOD). "Altro" si tiene solo se scelto.
 */
export function allowedRanges(timeline: GameSegment[], keep: string[]): Array<{ start: number; end: number }> {
  // Un "altro" che parla di un gioco scelto (es. "caricamento menu Call of Duty", visto su COD il
  // 2026-09-28) è quel gioco: l'AI a volte non lo mette sotto il gioco come le si chiede.
  const baseNames = keep.filter((k) => k !== "Altro").map((k) => k.split(":")[0]!.trim().toLowerCase());
  const aboutChosen = (s: GameSegment) => s.kind === "altro" && !!s.what && baseNames.some((b) => b.length >= 4 && s.what!.toLowerCase().includes(b));
  const chosen = (s: GameSegment) =>
    (s.kind === "gioco" && keep.includes(s.name)) || (s.kind === "altro" && (keep.includes("Altro") || aboutChosen(s)));
  const out: Array<{ start: number; end: number }> = [];
  timeline.forEach((s, i) => {
    const next = timeline[i + 1];
    if (chosen(s) || (s.kind === "ruota" && next && chosen(next))) {
      const last = out[out.length - 1];
      if (last && s.start - last.end < 1) last.end = s.end;
      else out.push({ start: s.start, end: s.end });
    }
  });
  return out;
}

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ModelTokenUsage } from "@clipforge/shared";
import { computeModelCostUsd, classifyModelTier } from "@clipforge/shared";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { runFfmpegBinary } from "../../lib/ffmpeg.js";
import { getAnthropicClient, cachedSystemPrompt, readCacheUsage, toolChoiceFor } from "./anthropic-client.js";
import { logger } from "../../lib/logger.js";
import { env } from "../../env.js";

/**
 * Cosa succede a schermo, a grana fine, nei video montati (simo, 2026-10-26): "si deve vedere loro
 * che giocano", menu brevi, e di ogni partita si vede come comincia e come finisce. La mappa dei
 * giochi (game-timeline.ts) guarda un fotogramma ogni 45 s e dice solo QUALE gioco; il montaggio
 * sceglieva leggendo la trascrizione, senza sapere se in quel momento c'era una partita o un menu: nel
 * montato di Switch Sports un terzo del video erano lobby e caricamenti.
 *
 * Un fotogramma piccolo ogni PHASE_SECONDS, solo nei tratti del gioco tenuto; l'AI dice per ognuno se
 * è partita, inizio, fine, menu o caricamento, e quale gioco/minigioco. Costo stimato ~0,07 $ per ora
 * di gioco; la mappa si salva su disco e un nuovo render della stessa clip non la ripaga.
 */

export type MatchPhase = "partita" | "inizio" | "fine" | "menu" | "caricamento" | "altro";

export interface PhaseSegment {
  /** Secondi dall'inizio della clip. */
  start: number;
  end: number;
  phase: MatchPhase;
  /** Gioco o minigioco ("Bowling", "Tennis"...), vuoto se non si capisce. */
  game: string;
}

export const PHASE_SECONDS = 10;
const FRAME_WIDTH = 256;
const MAX_FRAMES_PER_CALL = 80;
const TOOL_NAME = "fasi_partita";

const SYSTEM_PROMPT = `Guardi i fotogrammi (uno ogni ${PHASE_SECONDS} secondi) di una live Twitch italiana: streamer in call che giocano, con le webcam sovrapposte al gioco. Per ogni tratto dimmi in che FASE è il gioco, così il montatore tiene le partite e accorcia menu e attese.

Fasi:
- "inizio": comincia una partita o un round (schermata con i giocatori contro, conto alla rovescia, "Via!", "Round 1", presentazione della partita).
- "partita": si sta giocando (azione in corso).
- "fine": finisce una partita o un round (Vittoria, Sconfitta, Fine!, K.O., Risultato, classifica o punti di fine partita, replay del punto decisivo).
- "menu": lobby, scelta del gioco o della modalità, impostazioni, scelta squadre o personaggi, istruzioni e tutorial, "Gioca di nuovo?".
- "caricamento": schermo nero, "In attesa...", "Accesso in corso", schermate di caricamento.
- "altro": niente gioco (solo webcam, desktop, chat, browser).

"game": il gioco o il minigioco che si vede, sempre scritto uguale (in una raccolta di minigiochi come Switch Sports o Mario Party il MINIGIOCO: "Bowling", "Tennis", "Pallavolo", "Boxe"...). Vuoto se non si capisce.
Raggruppa i fotogrammi consecutivi con la stessa fase e lo stesso gioco in un tratto. Non inventare: se un fotogramma è ambiguo, dagli la fase dei vicini.`;

const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: "Restituisce i tratti con la fase del gioco.",
  input_schema: {
    type: "object",
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fromFrame: { type: "integer" },
            toFrame: { type: "integer" },
            phase: { type: "string", enum: ["partita", "inizio", "fine", "menu", "caricamento", "altro"] },
            game: { type: "string" },
          },
          required: ["fromFrame", "toFrame", "phase", "game"],
        },
      },
    },
    required: ["segments"],
  },
};

function parseJsonText(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const responseSchema = z.object({
  segments: z.preprocess(
    parseJsonText,
    z.array(
      z.preprocess(
        parseJsonText,
        z.object({
          fromFrame: z.coerce.number().int(),
          toFrame: z.coerce.number().int(),
          phase: z.enum(["partita", "inizio", "fine", "menu", "caricamento", "altro"]).catch("altro"),
          game: z.string().catch(""),
        }),
      ),
    ),
  ),
});

async function frameJpeg(videoPath: string, t: number): Promise<string | null> {
  try {
    const buffer = await runFfmpegBinary(
      ["-ss", t.toFixed(2), "-i", videoPath, "-frames:v", "1", "-vf", `scale=${FRAME_WIDTH}:-2`, "-q:v", "6", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
      { timeoutMs: 30 * 1000 },
    );
    return buffer.length > 0 ? buffer.toString("base64") : null;
  } catch {
    return null;
  }
}

/**
 * Fasi della clip (tempi in secondi dall'inizio della clip) dentro `ranges`, o null se fallisce.
 * `start`/`end` sono i secondi della clip nel sorgente.
 */
export async function detectMatchPhases(
  input: { sourceVideoPath: string; start: number; end: number; ranges: Array<{ start: number; end: number }> },
  options: { apiKey: string; model: string },
): Promise<PhaseSegment[] | null> {
  const key = crypto.createHash("sha1").update(JSON.stringify([path.resolve(input.sourceVideoPath), input.start, input.end, input.ranges, PHASE_SECONDS])).digest("hex").slice(0, 16);
  const cachePath = path.join(env.WORKER_TMP_DIR, "phase-cache", `${key}.json`);
  const cached = await fsp.readFile(cachePath, "utf8").catch(() => null);
  if (cached) return JSON.parse(cached) as PhaseSegment[];

  const times: number[] = [];
  for (const r of input.ranges) for (let t = r.start + PHASE_SECONDS / 2; t < r.end; t += PHASE_SECONDS) times.push(t);
  if (times.length < 2) return null;
  const usage: ModelTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  try {
    const client = getAnthropicClient(options.apiKey);
    const labels: Array<{ phase: MatchPhase; game: string } | undefined> = new Array(times.length);
    for (let from = 0; from < times.length; from += MAX_FRAMES_PER_CALL) {
      const chunk = times.slice(from, from + MAX_FRAMES_PER_CALL);
      const jpegs: Array<string | null> = [];
      for (let i = 0; i < chunk.length; i += 4) jpegs.push(...(await Promise.all(chunk.slice(i, i + 4).map((t) => frameJpeg(input.sourceVideoPath, input.start + t)))));
      const content: Exclude<Anthropic.MessageParam["content"], string> = [];
      const games = [...new Set(labels.filter((l) => l?.game).map((l) => l!.game))];
      if (games.length) content.push({ type: "text", text: `Giochi già visti prima (riusa gli stessi nomi): ${games.join(", ")}` });
      chunk.forEach((t, k) => {
        if (!jpegs[k]) return;
        content.push({ type: "text", text: `Fotogramma ${from + k} (min ${(t / 60).toFixed(1)}):` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegs[k]! } });
      });
      const message = await client.messages.create({
        model: options.model,
        max_tokens: 4000,
        system: cachedSystemPrompt(SYSTEM_PROMPT),
        messages: [{ role: "user", content }],
        tools: [TOOL],
        tool_choice: toolChoiceFor(options.model, TOOL_NAME),
      });
      usage.calls++;
      usage.input += message.usage.input_tokens;
      usage.output += message.usage.output_tokens;
      const cache = readCacheUsage(message.usage);
      usage.cacheRead += cache.cacheRead;
      usage.cacheWrite += cache.cacheWrite;
      const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME);
      const parsed = toolUse ? responseSchema.safeParse(toolUse.input) : null;
      if (!parsed?.success) {
        logger.warn("Fasi delle partite: risposta illeggibile", { input: toolUse ? JSON.stringify(toolUse.input).slice(0, 400) : null });
        return null;
      }
      for (const seg of parsed.data.segments) {
        for (let i = Math.max(seg.fromFrame, from); i <= Math.min(seg.toFrame, from + chunk.length - 1); i++) labels[i] = { phase: seg.phase, game: seg.game.trim() };
      }
    }
    for (let i = 0; i < labels.length; i++) labels[i] ??= labels[i - 1] ?? labels.slice(i).find(Boolean) ?? { phase: "altro", game: "" };

    // Ogni fotogramma vale per i PHASE_SECONDS attorno a sé; fra due tratti tenuti lontani non si unisce.
    const out: PhaseSegment[] = [];
    times.forEach((t, i) => {
      const l = labels[i]!;
      const start = t - PHASE_SECONDS / 2;
      const end = t + PHASE_SECONDS / 2;
      const last = out[out.length - 1];
      if (last && last.phase === l.phase && last.game === l.game && start - last.end < 1) last.end = end;
      else out.push({ start, end, phase: l.phase, game: l.game });
    });
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, JSON.stringify(out));
    logger.info("Fasi delle partite", { fotogrammi: times.length, tratti: out.length, partite: matchesFrom(out).length });
    return out;
  } catch (error) {
    logger.warn("Fasi delle partite fallite", { error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    const tier = classifyModelTier(options.model) ?? "sonnet";
    if (usage.calls > 0) logger.info("Costo REALE misurato — fasi delle partite", { model: options.model, ...usage, costUsd: computeModelCostUsd(tier, usage).toFixed(4) });
  }
}

export interface Match {
  start: number;
  end: number;
  game: string;
}

/** Partite/round: da un "inizio" (o dal primo momento di gioco) fino a "fine" o a un menu/caricamento. */
export function matchesFrom(phases: PhaseSegment[]): Match[] {
  const out: Match[] = [];
  let open: { start: number; end: number; games: Map<string, number> } | null = null;
  const close = (end: number) => {
    if (open && end - open.start >= 20) {
      const game = [...open.games.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      out.push({ start: open.start, end, game });
    }
    open = null;
  };
  for (const p of phases) {
    if (open && p.start - open.end > PHASE_SECONDS) close(open.end);
    if (p.phase === "inizio") {
      // Un nuovo "inizio" mentre si gioca è il round successivo.
      if (open && open.end - open.start >= 20) close(p.start);
      open ??= { start: p.start, end: p.end, games: new Map() };
      open.end = p.end;
    } else if (p.phase === "partita") {
      open ??= { start: p.start, end: p.end, games: new Map() };
      open.end = p.end;
      if (p.game) open.games.set(p.game, (open.games.get(p.game) ?? 0) + (p.end - p.start));
    } else if (p.phase === "fine") {
      if (open) close(p.end);
    } else if (open) {
      close(open.end);
    }
  }
  if (open) close((open as { end: number }).end);
  return out;
}

/** La mappa in righe corte per il prompt del montaggio. */
export function describePhases(phases: PhaseSegment[]): string {
  return phases.map((p) => `[${Math.round(p.start)}-${Math.round(p.end)}] ${p.phase}${p.game ? ` ${p.game}` : ""}`).join("\n");
}

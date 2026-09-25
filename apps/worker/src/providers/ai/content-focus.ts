import type { TranscriptSegment, ModelTokenUsage } from "@clipforge/shared";
import { OUTPUT_RESOLUTION, computeModelCostUsd, classifyModelTier } from "@clipforge/shared";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, cachedSystemPrompt, readCacheUsage, toolChoiceFor } from "./anthropic-client.js";
import { runFfmpegBinary } from "../../lib/ffmpeg.js";
import { logger } from "../../lib/logger.js";
import type { CropWindow, Layout } from "../../face-tracking/face-tracker.js";
import { fillsPanel, type ContentView } from "../../render/build-video-filter.js";

/**
 * Regia del pannello del gioco negli Shorts, come farebbe un montatore: di norma il gioco riempie il
 * pannello sotto la webcam e se ne vede il centro; qui l'AI guarda i fotogrammi e ascolta cosa dice
 * lo streamer, e decide i pochi tratti in cui serve altro:
 * - "full": il gioco intero per qualche secondo, quando conta qualcosa ai bordi (punteggio,
 *   minimappa, kill feed, un menu, una scena larga);
 * - "zoom": stretto su una cosa che lo streamer indica o legge ("guarda questo", "leggi qua").
 * Un errore qui non ferma mai il render: senza tratti il gioco resta semplicemente riempito.
 */

const TOOL_NAME = "return_content_views";

/** Un fotogramma ogni FRAME_STEP secondi, al massimo MAX_FRAMES (costo: ~300 token l'uno). */
const FRAME_STEP_SECONDS = 1.5;
const MAX_FRAMES = 32;
const FRAME_WIDTH = 768;

const MIN_VIEW_SECONDS = 1.2;
/** Solo per lo zoom: il gioco intero invece dura quanto serve (un quiz, un testo, un menu). */
const MAX_ZOOM_SECONDS = 8;
const MAX_VIEWS = 5;

const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Restituisce i tratti della clip in cui il pannello del gioco va mostrato intero o ingrandito. Lista vuota se non serve.",
  input_schema: {
    type: "object" as const,
    properties: {
      views: {
        type: "array",
        items: {
          type: "object",
          properties: {
            reason: { type: "string", description: "PRIMA di decidere: cosa dice o indica lo streamer e perché serve cambiare inquadratura." },
            start: { type: "number", description: "Secondo della clip in cui comincia il tratto." },
            end: { type: "number", description: "Secondo della clip in cui finisce il tratto." },
            mode: { type: "string", enum: ["full", "zoom"] },
            box: {
              type: "object",
              description: "Solo per zoom: il riquadro della cosa da mostrare, in millesimi del fotogramma (0-1000), margine compreso.",
              properties: {
                x0: { type: "number" },
                y0: { type: "number" },
                x1: { type: "number" },
                y1: { type: "number" },
              },
              required: ["x0", "y0", "x1", "y1"],
            },
          },
          required: ["reason", "start", "end", "mode"],
        },
      },
    },
    required: ["views"],
  },
};

const SYSTEM_PROMPT = `Sei il montatore di YouTube Shorts ricavati da live Twitch italiane. Nello Short la webcam sta sopra e il gioco sotto; il pannello del gioco è stretto, quindi normalmente del gioco si vede solo il CENTRO: nei fotogrammi che ricevi è l'area dentro il RETTANGOLO GIALLO. Quello che sta fuori dal rettangolo, di norma, non si vede.

Ricevi i fotogrammi del gioco (interi, con il rettangolo giallo) ogni ~1,5 secondi e quello che dice lo streamer, con i secondi. Decidi i pochi tratti in cui un montatore umano cambierebbe inquadratura:
- "full" (gioco intero per qualche secondo): quando conta qualcosa FUORI dal rettangolo giallo — lo streamer parla o reagisce a qualcosa ai bordi (punteggio, classifica, minimappa, kill feed, chat di gioco, un menu o una schermata che occupa tutto lo schermo), oppure l'azione importante succede fuori dal centro. Di solito 2-6 secondi; ma se sullo schermo c'è qualcosa da LEGGERE che esce dal rettangolo (un quiz con le risposte, una domanda, un testo, una classifica) il gioco intero resta per TUTTO il tempo in cui quella schermata è visibile: tagliare delle risposte o delle parole è l'errore peggiore.
- "zoom" (stretto su una cosa): quando lo streamer indica, legge o commenta una cosa PRECISA e piccola ("guarda questo", "leggi qua", "hai visto quello?", un oggetto, un nome, un testo, un personaggio). Il box deve contenere la cosa con un po' di margine, in millesimi del fotogramma. Durata 1,5-5 secondi.

Regole:
- Nel dubbio NON fare niente: il gioco riempito al centro va bene quasi sempre. Ogni tratto deve essere giustificato da quello che dice lo streamer o da qualcosa di chiaro nei fotogrammi. Di solito 0-2 tratti per clip, massimo ${MAX_VIEWS}.
- Il tratto comincia poco PRIMA della frase che lo giustifica (circa mezzo secondo) e finisce quando si passa ad altro.
- Guarda i fotogrammi del tratto: la cosa deve essere davvero lì in quei secondi, e per lo zoom deve stare ferma abbastanza da restare nel box.

Rispondi chiamando lo strumento ${TOOL_NAME} (lista vuota se non serve nessun tratto).`;

const numberish = z.coerce.number();
const viewSchema = z.object({
  reason: z.string().default(""),
  start: numberish,
  end: numberish,
  mode: z.enum(["full", "zoom"]),
  box: z.preprocess(parseJsonText, z.object({ x0: numberish, y0: numberish, x1: numberish, y1: numberish }).optional()),
});
const responseSchema = z.object({ views: z.preprocess(parseJsonText, z.array(z.unknown())) });

function parseJsonText(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

export interface ContentFocusInput {
  /** Il video su cui gira il filtro (tempi della clip, silenzi già tolti). */
  videoPath: string;
  layout: Layout;
  durationSeconds: number;
  /** Segmenti con le parole in tempi della clip. */
  segments: TranscriptSegment[];
}

export interface ContentFocusOptions {
  apiKey: string;
  model: string;
}

export async function planContentViews(input: ContentFocusInput, options: ContentFocusOptions): Promise<ContentView[]> {
  const frameTimes = sampleTimes(input.durationSeconds).filter((t) => fillPanelAt(input.layout, t, input.durationSeconds) !== null);
  // Nessun tratto con il gioco riempito (primi piani, reaction a un video verticale...): niente da decidere.
  if (frameTimes.length < 2) return [];

  const content: Anthropic.MessageParam["content"] = [{ type: "text", text: `Durata della clip: ${input.durationSeconds.toFixed(1)}s\n\nParlato:\n${speechLines(input.segments)}` }];
  const extracted: number[] = [];
  for (const t of frameTimes) {
    const panel = fillPanelAt(input.layout, t, input.durationSeconds)!;
    const jpeg = await extractFrame(input.videoPath, t, panel.content, panel.panelHeight).catch(() => null);
    if (!jpeg) continue;
    content.push({ type: "text", text: `Fotogramma a ${t.toFixed(1)}s:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg } });
    extracted.push(t);
  }
  if (extracted.length < 2) return [];

  const usage: ModelTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  try {
    const client = getAnthropicClient(options.apiKey);
    const message = await client.messages.create({
      model: options.model,
      max_tokens: 6000,
      system: cachedSystemPrompt(SYSTEM_PROMPT),
      messages: [{ role: "user", content }],
      tools: [TOOL_SCHEMA],
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
      logger.warn("Regia del gioco: risposta illeggibile, gioco riempito per tutta la clip", {
        stopReason: message.stop_reason,
        input: toolUse ? JSON.stringify(toolUse.input).slice(0, 600) : null,
      });
      return [];
    }
    const raw = parsed.data.views.map((v) => viewSchema.safeParse(parseJsonText(v))).flatMap((r) => (r.success ? [r.data] : []));
    const views = toContentViews(raw, input.layout, input.durationSeconds);
    logger.info("Regia del gioco", {
      frames: extracted.length,
      tratti: raw.map((v) => `${v.start.toFixed(1)}-${v.end.toFixed(1)} ${v.mode}: ${v.reason}`),
      applicati: views.map((v) => `${v.start.toFixed(1)}-${v.end.toFixed(1)} ${v.mode}`),
    });
    return views;
  } catch (error) {
    logger.warn("Regia del gioco fallita, gioco riempito per tutta la clip", { error: error instanceof Error ? error.message : String(error) });
    return [];
  } finally {
    const tier = classifyModelTier(options.model) ?? "sonnet";
    if (usage.calls > 0) logger.info("Costo REALE misurato — regia del gioco", { model: options.model, ...usage, costUsd: computeModelCostUsd(tier, usage).toFixed(4) });
  }
}

function sampleTimes(duration: number): number[] {
  const step = Math.max(FRAME_STEP_SECONDS, duration / MAX_FRAMES);
  const times: number[] = [];
  for (let t = step / 2; t < duration - 0.05; t += step) times.push(Math.round(t * 10) / 10);
  return times;
}

/** Il pannello del gioco in quell'istante, se c'è e se è di quelli riempiti (vedi fillsPanel). */
function fillPanelAt(layout: Layout, t: number, duration: number): { content: CropWindow; panelHeight: number } | null {
  const H = OUTPUT_RESOLUTION.height;
  let content: CropWindow;
  let topRatio: number;
  if (layout.type === "split_vertical") {
    content = layout.bottom;
    topRatio = layout.topRatio;
  } else {
    const scene = layout.scenes.find((s, i) => t >= s.startSeconds && (t < s.endSeconds || (i === layout.scenes.length - 1 && t <= duration)));
    if (scene?.composition.kind !== "split") return null;
    content = scene.composition.content;
    topRatio = scene.composition.topRatio;
  }
  const panelHeight = H - Math.round((H * topRatio) / 2) * 2;
  return fillsPanel(content, panelHeight) ? { content, panelHeight } : null;
}

/** Fotogramma del contenuto intero, con il rettangolo giallo dell'area visibile quando è riempito. */
async function extractFrame(videoPath: string, t: number, content: CropWindow, panelHeight: number): Promise<string> {
  const scale = FRAME_WIDTH / content.width;
  const visibleWidth = (OUTPUT_RESOLUTION.width * content.height) / panelHeight;
  const boxX = Math.round(((content.width - visibleWidth) / 2) * scale);
  const boxW = Math.round(visibleWidth * scale);
  const boxH = Math.round(content.height * scale);
  const buffer = await runFfmpegBinary(
    [
      "-ss",
      t.toFixed(2),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      `crop=${content.width}:${content.height}:${content.x}:${content.y},scale=${FRAME_WIDTH}:-2,drawbox=x=${boxX}:y=0:w=${boxW}:h=${boxH}:color=yellow@0.9:t=3`,
      "-q:v",
      "4",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-",
    ],
    { timeoutMs: 30 * 1000 },
  );
  return buffer.toString("base64");
}

/** Parole raggruppate in frasi brevi con il secondo d'inizio: "[12.3] guarda questo coso". */
function speechLines(segments: TranscriptSegment[]): string {
  const words = segments.flatMap((s) => s.words).sort((a, b) => a.start - b.start);
  const lines: string[] = [];
  let current: typeof words = [];
  const flush = () => {
    if (current.length > 0) lines.push(`[${current[0]!.start.toFixed(1)}] ${current.map((w) => w.word.trim()).join(" ")}`);
    current = [];
  };
  for (const w of words) {
    const last = current[current.length - 1];
    if (last && (w.start - last.end > 0.6 || current.length >= 8)) flush();
    current.push(w);
  }
  flush();
  return lines.join("\n") || "(nessun parlato)";
}

/** Dalle risposte del modello ai tratti da montare: tempi puliti, niente sovrapposizioni, zoom dentro il gioco. */
function toContentViews(raw: Array<z.infer<typeof viewSchema>>, layout: Layout, duration: number): ContentView[] {
  const views: ContentView[] = [];
  for (const v of [...raw].sort((a, b) => a.start - b.start)) {
    let start = Math.max(0, v.start);
    let end = Math.min(duration, v.end);
    // Il tratto parte dalla prima scena col gioco riempito che tocca: il modello lo fa cominciare
    // mezzo secondo prima della frase, e quel mezzo secondo può cadere in un primo piano (visto sul
    // quiz: la schermata "commenta con la risposta bonus" restava tagliata).
    if (layout.type === "scenes") {
      const scene = layout.scenes.find(
        (s) => s.endSeconds > start && s.startSeconds < end && fillPanelAt(layout, Math.max(start, s.startSeconds), duration) !== null,
      );
      if (!scene) continue;
      start = Math.max(start, scene.startSeconds);
      // Lo zoom resta dentro la sua scena: in un'altra il gioco può stare altrove. Il gioco intero
      // no, vale uguale in ogni scena col gioco.
      if (v.mode === "zoom") end = Math.min(end, scene.endSeconds);
    }
    if (v.mode === "zoom") end = Math.min(end, start + MAX_ZOOM_SECONDS);
    const panel = fillPanelAt(layout, start, duration);
    if (!panel) continue;
    const previous = views[views.length - 1];
    if (previous && start < previous.end) start = previous.end;
    if (end - start < MIN_VIEW_SECONDS) continue;

    if (v.mode === "full") {
      views.push({ start, end, mode: "full" });
    } else if (v.box) {
      const { content } = panel;
      const clamp = (n: number) => Math.max(0, Math.min(1000, n));
      const x0 = clamp(Math.min(v.box.x0, v.box.x1));
      const x1 = clamp(Math.max(v.box.x0, v.box.x1));
      const y0 = clamp(Math.min(v.box.y0, v.box.y1));
      const y1 = clamp(Math.max(v.box.y0, v.box.y1));
      if (x1 - x0 < 10 || y1 - y0 < 10) continue;
      views.push({
        start,
        end,
        mode: "zoom",
        region: {
          x: Math.round(content.x + (x0 / 1000) * content.width),
          y: Math.round(content.y + (y0 / 1000) * content.height),
          width: Math.round(((x1 - x0) / 1000) * content.width),
          height: Math.round(((y1 - y0) / 1000) * content.height),
        },
      });
    }
    if (views.length >= MAX_VIEWS) break;
  }
  return views;
}

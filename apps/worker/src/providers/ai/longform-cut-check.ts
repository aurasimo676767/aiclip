import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ModelTokenUsage, TranscriptSegment } from "@clipforge/shared";
import { classifyModelTier, computeModelCostUsd } from "@clipforge/shared";
import { runFfmpegBinary } from "../../lib/ffmpeg.js";
import { logger } from "../../lib/logger.js";
import { PhraseLocator, type Word } from "../../render/intro-moments.js";
import { cachedSystemPrompt, createMessage, getAnthropicClient, readCacheUsage, toolChoiceFor } from "./anthropic-client.js";
import { withDiskCache } from "./response-cache.js";
import { fmt } from "./longform-plan.js";

/**
 * Controllo finale dei tagli dei video lunghi, GUARDANDO LO SCHERMO oltre che leggendo il parlato
 * (simo, 2026-11-05: clip "incomplete, in mezzo alla discussione, a video già iniziato"; "devono
 * essere ultra aura, stra funzionanti").
 *
 * La mappa e la rifinitura (longform-plan.ts, longform-boundaries.ts) decidono solo dal transcript, a
 * righe da ~25 secondi: non sanno se a schermo c'è ancora la partita o già la schermata dei risultati.
 * Visto sul VOD Manchester-Roma: Mimic Party finiva alle 5:00:00 con la schermata "TEAM RED WINS"
 * ancora a schermo per 10 secondi; il primo video partiva a metà di una frase ("...per una guerra
 * termonucleare"), perché le righe del transcript si spezzano ogni 10 minuti anche a metà frase.
 *
 * Per ogni confine: fotogrammi ogni FRAME_STEP_SECONDS e le righe del transcript attorno; il modello
 * dice se il taglio è giusto e, solo se è chiaramente sbagliato, dove va. Poi il punto scelto si
 * mette in una pausa fra due frasi, coi tempi delle parole del Whisper locale (gratis). Due confini
 * attaccati (un video finisce dove comincia il successivo) sono UNA domanda sola: dove finisce uno e
 * comincia l'altro, così il primo non si allunga mangiando l'inizio del secondo.
 */

const FRAME_STEP_SECONDS = 6;
const FRAME_WIDTH = 320;
/** Finestra guardata attorno al taglio (secondi prima, dopo). */
const START_WINDOW = { before: 150, after: 60 };
const END_WINDOW = { before: 60, after: 150 };
const SHARED_WINDOW = { before: 120, after: 120 };
/** Un video non scende mai sotto questa durata per un confine spostato. */
const MIN_VIDEO_SECONDS = 60;
/** Il punto scelto si sposta fino a tanto per cadere fra due frasi. */
const SNAP_SECONDS = 10;
/** Silenzio fra due parole che vale come pausa fra due frasi. */
const PAUSE_SECONDS = 0.5;
const PARALLEL_CALLS = 3;
const TOOL_NAME = "verifica_taglio";

export interface CutVideo {
  start: number;
  end: number;
  activity: string;
  kind: "game" | "tournament" | "reaction" | "talk";
  tournament?: string;
}

export interface CutCheckOptions {
  apiKey: string;
  model: string;
  openaiApiKey: string;
  sourceVideoPath: string;
  /** Transcript del VOD intero (tempi del VOD). */
  segments: TranscriptSegment[];
  videoDurationSeconds: number;
  /** Fin dove può allargarsi ogni video (stesso ordine di `videos`): al render sono le clip vicine. */
  limits?: Array<{ lower: number; upper: number }>;
}

type Boundary =
  | { id: string; side: "start"; video: number; at: number; lower: number; upper: number }
  | { id: string; side: "end"; video: number; at: number; lower: number; upper: number }
  | { id: string; side: "shared"; prev: number; next: number; at: number; lower: number; upper: number };

const SYSTEM_PROMPT = `Sei il montatore di un canale YouTube che ripubblica le live Twitch di streamer italiani (giochi di gruppo, tornei, reaction) come video lunghi, un video per attività. Controlli UN taglio: ricevi l'attività del video, se è l'INIZIO, la FINE, o il punto in cui un video finisce e comincia il successivo, il transcript dei minuti attorno (righe "[secondi] testo", ~25 secondi l'una) e i fotogrammi a schermo (uno ogni ${FRAME_STEP_SECONDS} secondi, con i secondi del VOD).

INIZIO di un video:
- deve partire dall'inizio dell'attività, preparazione compresa: l'annuncio ("ora giochiamo a...", "adesso guardiamo..."), la scelta del gioco o del video, la ruota, il caricamento, la lobby. Per una reaction: da quando annunciano o aprono la cosa da guardare.
- È SBAGLIATO se nei fotogrammi PRIMA del taglio si vede già lo stesso gioco in partita o lo stesso video che scorre (il video partirebbe con l'attività già iniziata), o se il taglio cade a metà di un discorso.
- Non va dentro: la fine dell'attività di prima, chiacchiere su altro, i saluti di inizio live.

FINE di un video:
- dopo la conclusione: l'ultima schermata di risultato (vittoria, sconfitta, classifica, "TEAM ... WINS", punteggio finale), le reazioni a caldo, i saluti del video reagito.
- È SBAGLIATA se DOPO il taglio si vede ancora la partita in corso, la schermata del risultato, o il video reagito che continua, o se il taglio cade a metà di una frase.
- Finisce appena passano davvero ad altro (un altro gioco, un altro video, chiacchiere su altro).

PUNTO CONDIVISO (un video finisce e il successivo comincia nello stesso punto): il punto in cui la prima attività è davvero finita (risultato compreso) e comincia la seconda (annuncio, scelta, caricamento).

Lo schermo conta quanto il parlato: menu, caricamenti e schermate di fine di un gioco fanno parte di quel gioco. Nel dubbio rispondi "giusto": sposta il taglio SOLO se fotogrammi o parlato mostrano chiaramente che è sbagliato. Se lo sposti, "secondi" è il secondo di un fotogramma o di una riga del transcript che vedi. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: "Dice se il taglio è giusto e, se no, dove va.",
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "PRIMA di decidere: cosa si vede e cosa dicono prima e dopo il taglio, in due o tre frasi." },
      verdict: { type: "string", enum: ["giusto", "sposta"] },
      seconds: { type: "number", description: "Solo se verdict è \"sposta\": il secondo del VOD dove va il taglio." },
    },
    required: ["reason", "verdict"],
  },
};

const answerSchema = z.object({
  reason: z.string().default(""),
  verdict: z.enum(["giusto", "sposta"]).catch("giusto"),
  seconds: z.coerce.number().optional(),
});
type Answer = z.infer<typeof answerSchema>;

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

function boundariesOf(videos: CutVideo[], options: CutCheckOptions): Boundary[] {
  const out: Boundary[] = [];
  const sameTournament = (a: CutVideo, b: CutVideo) => !!a.tournament && a.tournament === b.tournament;
  videos.forEach((v, i) => {
    const prev = videos[i - 1];
    const next = videos[i + 1];
    const limit = options.limits?.[i];
    const shared = prev && Math.abs(prev.end - v.start) <= 2;
    // Fra due giochi dello stesso torneo il confine è il giro della ruota (splitTournamentByGame): non si tocca.
    if (shared && !sameTournament(prev, v)) {
      out.push({ id: `v${i - 1}-v${i}`, side: "shared", prev: i - 1, next: i, at: v.start, lower: prev.start + MIN_VIDEO_SECONDS, upper: v.end - MIN_VIDEO_SECONDS });
    } else if (!shared) {
      out.push({ id: `v${i}-inizio`, side: "start", video: i, at: v.start, lower: limit?.lower ?? prev?.end ?? 0, upper: v.end - MIN_VIDEO_SECONDS });
    }
    if (!next || Math.abs(v.end - next.start) > 2) {
      out.push({ id: `v${i}-fine`, side: "end", video: i, at: v.end, lower: v.start + MIN_VIDEO_SECONDS, upper: limit?.upper ?? next?.start ?? options.videoDurationSeconds });
    }
  });
  return out;
}

function describe(b: Boundary, videos: CutVideo[]): string {
  const name = (v: CutVideo) => `"${v.activity}" (${v.kind === "reaction" ? "reaction" : v.kind === "talk" ? "argomento" : "gioco"}${v.tournament ? `, torneo "${v.tournament}"` : ""})`;
  if (b.side === "shared") return `PUNTO CONDIVISO: qui finisce il video ${name(videos[b.prev]!)} e comincia il video ${name(videos[b.next]!)}.`;
  return `${b.side === "start" ? "INIZIO" : "FINE"} del video ${name(videos[b.video]!)}.`;
}

export async function checkCuts<T extends CutVideo>(videos: T[], options: CutCheckOptions): Promise<{ videos: T[]; usage: ModelTokenUsage; changes: string[] }> {
  const usage: ModelTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  const out = videos.map((v) => ({ ...v }));
  const changes: string[] = [];
  const boundaries = boundariesOf(videos, options);
  const sorted = [...options.segments].sort((a, b) => a.start - b.start);
  const locator = new PhraseLocator({ segments: [], sourceVideoPath: options.sourceVideoPath, clipStart: 0, clipDuration: options.videoDurationSeconds, openaiApiKey: options.openaiApiKey });

  try {
    const answers = new Map<string, Answer | null>();
    for (let i = 0; i < boundaries.length; i += PARALLEL_CALLS) {
      const chunk = boundaries.slice(i, i + PARALLEL_CALLS);
      const results = await Promise.all(chunk.map((b) => askBoundary(b, videos, sorted, options, usage)));
      chunk.forEach((b, k) => answers.set(b.id, results[k]!));
    }

    for (const b of boundaries) {
      const answer = answers.get(b.id);
      let target = b.at;
      if (answer?.verdict === "sposta" && answer.seconds !== undefined && Number.isFinite(answer.seconds)) {
        if (answer.seconds >= b.lower && answer.seconds <= b.upper) target = answer.seconds;
        else logger.warn("Controllo tagli: punto fuori dai limiti, ignorato", { confine: b.id, secondi: answer.seconds, limiti: [b.lower, b.upper] });
      }
      // Fra due frasi, mai dentro una parola: un inizio si sposta all'inizio della frase, una fine alla sua fine.
      const snapped = await snapToPause(locator, target, b.side === "end" ? "end" : "start").catch(() => target);
      const value = Math.min(b.upper, Math.max(b.lower, snapped));
      if (Math.abs(value - b.at) > 1) changes.push(`${b.id} ${fmt(b.at)} -> ${fmt(value)}${answer?.verdict === "sposta" ? ` (${answer.reason})` : " (tra due frasi)"}`);
      if (b.side === "shared") {
        out[b.prev]!.end = value;
        out[b.next]!.start = value;
      } else if (b.side === "start") out[b.video]!.start = value;
      else out[b.video]!.end = value;
    }
  } finally {
    await locator.dispose();
  }

  const tier = classifyModelTier(options.model) ?? "sonnet";
  logger.info("Costo REALE misurato — controllo tagli a schermo", { model: options.model, ...usage, costUsd: computeModelCostUsd(tier, usage).toFixed(4) });
  logger.info("Controllo tagli a schermo", { confini: boundaries.length, modifiche: changes });
  return { videos: out, usage, changes };
}

async function askBoundary(b: Boundary, videos: CutVideo[], sorted: TranscriptSegment[], options: CutCheckOptions, usage: ModelTokenUsage): Promise<Answer | null> {
  const win = b.side === "start" ? START_WINDOW : b.side === "end" ? END_WINDOW : SHARED_WINDOW;
  const from = Math.max(0, b.at - win.before);
  const to = Math.min(options.videoDurationSeconds, b.at + win.after);
  const times: number[] = [];
  for (let t = from; t <= to; t += FRAME_STEP_SECONDS) times.push(t);
  const lines = sorted.filter((s) => s.end > from && s.start < to).map((s) => `[${Math.round(s.start)}] ${s.text.trim()}`);
  const header = `${describe(b, videos)}\nTaglio attuale: secondo ${Math.round(b.at)} (${fmt(b.at)}).\n\nTranscript:\n${lines.join("\n")}\n\nFotogrammi:`;

  return withDiskCache("controllo-tagli", [options.model, SYSTEM_PROMPT, options.sourceVideoPath, header, times], async () => {
    const jpegs: Array<string | null> = [];
    for (let i = 0; i < times.length; i += 4) jpegs.push(...(await Promise.all(times.slice(i, i + 4).map((t) => frameJpeg(options.sourceVideoPath, t)))));
    const content: Exclude<Anthropic.MessageParam["content"], string> = [{ type: "text", text: header }];
    times.forEach((t, k) => {
      if (!jpegs[k]) return;
      content.push({ type: "text", text: `[${Math.round(t)}]${Math.abs(t - b.at) < FRAME_STEP_SECONDS / 2 ? " ← taglio attuale" : ""}` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegs[k]! } });
    });
    try {
      const message = await createMessage(getAnthropicClient(options.apiKey), {
        model: options.model,
        max_tokens: 2000,
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
      const toolUse = message.content.find((x): x is Anthropic.ToolUseBlock => x.type === "tool_use" && x.name === TOOL_NAME);
      const parsed = toolUse ? answerSchema.safeParse(toolUse.input) : null;
      if (!parsed?.success) {
        logger.warn("Controllo tagli: risposta illeggibile", { confine: b.id });
        return null;
      }
      logger.info("Controllo tagli: un confine", { confine: b.id, a: fmt(b.at), esito: parsed.data.verdict, secondi: parsed.data.seconds, motivo: parsed.data.reason });
      return parsed.data;
    } catch (error) {
      logger.warn("Controllo tagli fallito per un confine: resta com'è", { confine: b.id, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });
}

/**
 * Il punto più vicino fra due frasi. Inizio: si torna all'inizio della frase in cui cade (fino a
 * SNAP_SECONDS prima), un attimo prima della prima parola. Fine: si va alla fine della frase (fino a
 * SNAP_SECONDS dopo), un attimo dopo l'ultima parola. Se nel tratto non parla nessuno, resta dov'è.
 */
async function snapToPause(locator: PhraseLocator, at: number, side: "start" | "end"): Promise<number> {
  const words: Word[] = (await locator.words(at - SNAP_SECONDS - 2, at + SNAP_SECONDS + 2)).sort((a, b) => a.start - b.start);
  if (words.length === 0) return at;
  const speaking = words.some((w) => w.start - 0.15 < at && w.end + 0.15 > at);
  const prevWord = [...words].reverse().find((w) => w.end <= at);
  const nextWord = words.find((w) => w.start >= at);
  const inPause = !speaking && (!prevWord || !nextWord || nextWord.start - prevWord.end >= PAUSE_SECONDS);
  if (inPause) return at;

  // Pause fra parole consecutive: [fine parola prima, inizio parola dopo].
  const pauses: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < words.length; i++) if (words[i]!.start - words[i - 1]!.end >= PAUSE_SECONDS) pauses.push({ from: words[i - 1]!.end, to: words[i]!.start });
  if (side === "start") {
    const before = pauses.filter((p) => p.to <= at + 0.2 && at - p.to <= SNAP_SECONDS).pop();
    return before ? before.to - 0.3 : at;
  }
  const after = pauses.find((p) => p.from >= at - 0.2 && p.from - at <= SNAP_SECONDS);
  return after ? after.from + 0.3 : at;
}

/** Segno sulla clip che i suoi tagli sono già stati controllati (in clips.render_plan dei video lunghi). */
export interface CutCheckMark {
  cutCheck: { start: number; end: number; at: string };
}

export function cutCheckMark(start: number, end: number): CutCheckMark {
  return { cutCheck: { start, end, at: new Date().toISOString() } };
}

export function isCutChecked(plan: unknown, start: number, end: number): boolean {
  const mark = (plan as Partial<CutCheckMark> | null)?.cutCheck;
  return !!mark && Math.abs(mark.start - start) < 0.5 && Math.abs(mark.end - end) < 0.5;
}

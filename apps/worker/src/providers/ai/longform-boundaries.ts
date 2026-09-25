import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { TranscriptSegment, ModelTokenUsage } from "@clipforge/shared";
import { classifyModelTier, computeModelCostUsd } from "@clipforge/shared";
import { getAnthropicClient, cachedSystemPrompt, readCacheUsage, toolChoiceFor } from "./anthropic-client.js";
import type { PlannedVideo } from "./longform-plan.js";
import { fmt } from "./longform-plan.js";
import { logger } from "../../lib/logger.js";

/**
 * Rifinitura degli INIZI e delle FINI dei video long-form, dopo la mappa del VOD (longform-plan.ts).
 *
 * Perché serve: la mappa decide bene COSA è un video, ma i bordi dei suoi blocchi sono grossolani
 * proprio dove conta. Verificato su VOD veri: la preparazione di Black Ops 2 (clan, lobby, "metto
 * il mio clan preferito") finiva in un blocco "chiacchiere" e il video partiva 5 minuti e mezzo
 * dopo; l'inizio di una reaction veniva etichettato come un'attività diversa e scartato. Qui ogni
 * confine viene riletto da vicino: pochi minuti di transcript attorno, e la domanda è una sola —
 * da quale riga comincia (o fino a quale riga arriva) DAVVERO questa attività.
 *
 * Tutti i confini di un VOD vanno in UNA chiamata (~15-25k token, pochi centesimi).
 */

/** Quanto prima dell'inizio proposto si guarda: la preparazione può cominciare minuti prima. */
const LOOK_BEFORE_START_SECONDS = 10 * 60;
const LOOK_AFTER_START_SECONDS = 3 * 60;
const LOOK_BEFORE_END_SECONDS = 3 * 60;
const LOOK_AFTER_END_SECONDS = 12 * 60;

const TOOL_NAME = "return_boundaries";

const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Restituisce il secondo esatto (inizio di una riga del transcript) di ogni confine.",
  input_schema: {
    type: "object" as const,
    properties: {
      boundaries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "L'id del confine, copiato dalla richiesta." },
            reason: {
              type: "string",
              description: "PRIMA di scegliere: cosa succede nelle righe attorno al taglio e dove comincia/finisce davvero l'attività, in una o due frasi.",
            },
            line: { type: "number", description: "I secondi della RIGA scelta, copiati dal transcript (il numero fra parentesi quadre)." },
          },
          required: ["id", "reason", "line"],
        },
      },
    },
    required: ["boundaries"],
  },
};

const SYSTEM_PROMPT = `Sei il montatore che rifinisce i tagli di video long-form ricavati da live Twitch italiane (giochi di gruppo, tornei, reaction). Per ogni confine ricevi: l'attività del video, se è l'INIZIO o la FINE, dove sta ora il taglio, e il transcript dei minuti attorno (righe "[secondi] testo", ogni riga ~25 secondi).

Per un INIZIO scegli la riga da cui il video deve partire. Leggi la finestra DALL'ALTO: la risposta è la PRIMA riga, dall'alto, che appartiene già all'attività (preparazione compresa) — non la riga in cui "entrano in partita".
- il video comincia dove comincia l'attività, PREPARAZIONE INCLUSA: l'annuncio ("ora giochiamo a...", "adesso guardiamo..."), la scelta del gioco, il giro della ruota, il download, la lobby, la creazione di squadre/classi/clan, la spiegazione delle regole. Tutto questo fa parte del video.
- per una reaction: da quando annunciano o aprono la cosa da guardare, o dalla PRIMA riga in cui si sentono le voci del video reagito (persone che si presentano, un narratore, dialoghi che non sono dello streamer) o in cui commentano quello che stanno guardando — anche se la mappa lo mette più avanti.
- NON va dentro: chiacchiere su altro che vengono prima, la fine dell'attività precedente, i saluti di inizio live.
- nel dubbio fra due righe, scegli quella PRIMA: meglio qualche secondo di troppo che l'inizio tagliato.

Per una FINE scegli l'ULTIMA riga in cui si parla ancora DI QUESTA attività:
- include la chiusura naturale: il risultato finale, i saluti del video reagito, le reazioni a caldo e i commenti su quello che è appena successo.
- appena passano a parlare d'ALTRO il video è finito, anche se l'argomento nuovo è nato da lì: calcio, notizie, la chat, organizzarsi per la cosa dopo, chi entra in call. Verificato: una reaction continuata per 6 minuti di chiacchiere su Mbappé dopo i saluti del video — sbagliato.
- se il transcript mostra che stanno ancora giocando/guardando oltre il taglio attuale, sposta la fine più avanti.

Rispondi per TUTTI i confini, con i secondi copiati esattamente da una riga del transcript di quel confine. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

const responseSchema = z.object({
  boundaries: z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    },
    z.array(z.object({ id: z.string(), line: z.number(), reason: z.string().default("") })),
  ),
});

interface BoundaryTask {
  id: string;
  videoIndex: number;
  side: "start" | "end";
  current: number;
  lines: TranscriptSegment[];
}

export interface BoundaryRefinementOptions {
  apiKey: string;
  model: string;
  videoDurationSeconds: number;
}

export async function refineVideoBoundaries(
  videos: PlannedVideo[],
  segments: TranscriptSegment[],
  options: BoundaryRefinementOptions,
): Promise<{ videos: PlannedVideo[]; usage: ModelTokenUsage }> {
  const usage: ModelTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  if (videos.length === 0) return { videos, usage };

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const linesIn = (from: number, to: number) => sorted.filter((s) => s.start >= from && s.start < to);
  const refined = videos.map((v) => ({ ...v }));
  const changes: string[] = [];

  let tasks: BoundaryTask[] = [];
  refined.forEach((v, i) => {
    const prevEnd = refined[i - 1]?.end ?? 0;
    const nextStart = refined[i + 1]?.start ?? options.videoDurationSeconds;
    // Le parti di uno stesso torneo si toccano: il loro confine comune l'ha già scelto il codice sul
    // giro della ruota (vedi splitLongVideo), qui non si sposta.
    const sharedWithPrev = i > 0 && refined[i - 1]!.activity === v.activity && v.part !== undefined;
    const sharedWithNext = i < refined.length - 1 && refined[i + 1]!.activity === v.activity && v.part !== undefined;
    if (!sharedWithPrev) {
      tasks.push({
        id: `v${i}-start`,
        videoIndex: i,
        side: "start",
        current: v.start,
        lines: linesIn(Math.max(prevEnd, v.start - LOOK_BEFORE_START_SECONDS), Math.min(v.end, v.start + LOOK_AFTER_START_SECONDS)),
      });
    }
    if (!sharedWithNext) {
      tasks.push({
        id: `v${i}-end`,
        videoIndex: i,
        side: "end",
        current: v.end,
        lines: linesIn(Math.max(v.start, v.end - LOOK_BEFORE_END_SECONDS), Math.min(nextStart, v.end + LOOK_AFTER_END_SECONDS)),
      });
    }
  });

  // Fino a MAX_ROUNDS giri: se la riga scelta è proprio l'ultima (per una fine) o la prima (per un
  // inizio) della finestra, l'attività probabilmente continua oltre — verificato: un Black Ops 2 che
  // andava avanti fino ai saluti finali veniva fermato al bordo della finestra. Si riguarda allora
  // più in là, solo per quei confini.
  for (let round = 1; round <= MAX_ROUNDS && tasks.length > 0; round++) {
    const usable = tasks.filter((t) => t.lines.length >= 2);
    if (usable.length === 0) break;
    const answers = await askBoundaries(usable, refined, options, usage);
    if (!answers) break;

    const nextRound: BoundaryTask[] = [];
    for (const task of usable) {
      const answer = answers.find((b) => b.id === task.id);
      if (!answer) continue;
      // Solo righe vere di QUEL confine: un numero inventato o preso da un altro confine si ignora.
      const index = task.lines.findIndex((l) => Math.abs(l.start - answer.line) < 1.5);
      if (index < 0) continue;
      const line = task.lines[index]!;
      const video = refined[task.videoIndex]!;
      const value = task.side === "start" ? line.start : line.end;
      if (task.side === "start") video.start = value;
      else video.end = value;
      if (Math.abs(value - task.current) > 1) changes.push(`${task.id} ${fmt(task.current)} -> ${fmt(value)} (${answer.reason})`);

      const atEdge = task.side === "end" ? index === task.lines.length - 1 : index === 0;
      if (!atEdge) continue;
      const i = task.videoIndex;
      if (task.side === "end") {
        const limit = refined[i + 1]?.start ?? options.videoDurationSeconds;
        const lines = linesIn(line.start, Math.min(limit, line.start + LOOK_AFTER_END_SECONDS));
        if (lines.length >= 2) nextRound.push({ ...task, current: value, lines });
      } else {
        const limit = refined[i - 1]?.end ?? 0;
        const lines = linesIn(Math.max(limit, line.start - LOOK_BEFORE_START_SECONDS), line.start + 1);
        if (lines.length >= 2) nextRound.push({ ...task, current: value, lines });
      }
    }
    tasks = nextRound;
  }

  const tier = classifyModelTier(options.model) ?? "sonnet";
  logger.info("Costo REALE misurato — rifinitura confini long-form", { ...usage, costUsd: computeModelCostUsd(tier, usage).toFixed(4) });

  // Niente sovrapposizioni dopo la rifinitura: se un inizio anticipato entra nella fine del video
  // precedente, vince l'inizio (è un confine esplicito: annuncio, ruota, lobby).
  refined.sort((a, b) => a.start - b.start);
  for (let i = 1; i < refined.length; i++) {
    const prev = refined[i - 1]!;
    if (prev.end > refined[i]!.start) prev.end = refined[i]!.start;
  }
  logger.info("Confini dei video rifiniti", { modifiche: changes });
  return { videos: refined.filter((v) => v.end - v.start >= 60), usage };
}

const MAX_ROUNDS = 2;

/** Una chiamata con tutti i confini del giro; null se il modello non dà un output valido. */
async function askBoundaries(
  tasks: BoundaryTask[],
  videos: PlannedVideo[],
  options: BoundaryRefinementOptions,
  usage: ModelTokenUsage,
): Promise<Array<{ id: string; line: number; reason: string }> | null> {
  const userPrompt = tasks
    .map((t) => {
      const v = videos[t.videoIndex]!;
      return `### Confine ${t.id} — ${t.side === "start" ? "INIZIO" : "FINE"} del video "${v.activity}" (${v.kind}${v.part ? `, parte ${v.part}` : ""})
Contenuto del video: ${v.topic}
${t.side === "start" ? `Come comincia secondo la mappa: ${v.opening}` : `Come finisce secondo la mappa: ${v.closing}`}
Taglio attuale: [${Math.round(t.current)}]
Transcript:
${t.lines.map((l) => `[${Math.round(l.start)}] ${l.text}`).join("\n")}`;
    })
    .join("\n\n");

  const client = getAnthropicClient(options.apiKey);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const message = await client.messages.create({
      model: options.model,
      max_tokens: 16000,
      system: cachedSystemPrompt(SYSTEM_PROMPT),
      messages,
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
    const result = toolUse ? responseSchema.safeParse(toolUse.input) : null;
    if (result?.success) return result.data.boundaries;
    logger.warn("Rifinitura dei confini non valida", { attempt, stopReason: message.stop_reason });
    if (!toolUse) continue;
    messages.push({ role: "assistant", content: message.content });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: `Output non valido. Richiama ${TOOL_NAME} rispettando lo schema.` }],
    });
  }
  logger.warn("Rifinitura dei confini fallita per questo giro: restano i confini precedenti");
  return null;
}

import type { TranscriptSegment, ModelTokenUsage } from "@clipforge/shared";
import { computeModelCostUsd, classifyModelTier } from "@clipforge/shared";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, cachedSystemPrompt, readCacheUsage, toolChoiceFor } from "./anthropic-client.js";
import { logger } from "../../lib/logger.js";

/**
 * Montaggio "da YouTuber" di un video long-form (chiesto da simo il 2026-09-28): il montaggio
 * automatico di prima toglieva solo i silenzi veri, e su un'ora di Call of Duty tagliava 47 secondi
 * ("non mi è sembrato montato"). Qui l'AI legge tutta la trascrizione e decide come un montatore:
 * - un solo argomento (il gioco del video): le divagazioni in mezzo si tolgono del tutto;
 * - via le parti morte (attese, menu, chiacchiere a vuoto), tenuti i momenti divertenti col loro contesto;
 * - il video finisce quando smettono di giocare;
 * - 2 momenti cortissimi e folli per l'intro "IN QUESTO VIDEO" (fino a ~10 s in tutto).
 * La durata è quella che serve. Una chiamata per video: con Sonnet 5 circa 10 centesimi per un'ora.
 */

export interface HighlightsRange {
  start: number;
  end: number;
}

export interface HighlightsPlan {
  /** Tratti da tenere, in ordine, in secondi dall'inizio del video long-form. */
  keep: HighlightsRange[];
  /** Candidati per l'intro (fino a 4), con le parole esatte della reazione: vedi render/intro-moments.ts. */
  intro: Array<HighlightsRange & { quote: string }>;
}

const TOOL_NAME = "monta_video";

const SYSTEM_PROMPT = `Sei il montatore di un canale YouTube italiano che ripubblica le live di streamer (Blur, Marza, Pesh, Manuxo, Lollo...). Ricevi la trascrizione con i tempi (secondi dall'inizio del pezzo) di un pezzo di live dedicato a UN argomento, di solito un gioco, e i momenti in cui qualcuno alza molto la voce, misurati sull'audio vero. Devi montarlo come fanno gli YouTuber che fanno milioni di visualizzazioni.

COSA TENERE E COSA TOGLIERE
- UN SOLO ARGOMENTO: il video parla solo di quello del titolo. Se in mezzo parlano d'altro (leggono la chat su altri temi, parlano di altri giochi, di soldi, di sponsor, di cosa mangiano) e poi tornano al gioco, quel pezzo si toglie TUTTO.
- VIA LE PARTI MORTE: attese, caricamenti, menu, silenzi, "vabbè", tentativi ripetuti uguali senza niente di divertente, chiacchiere che non portano a niente.
- TIENI i momenti che fanno ridere, arrabbiare o stupire, CON il loro contesto: il setup che serve a capire la battuta, la battuta, la reazione. Mai la sola frase finale staccata dal resto.
- FINE: il video finisce quando smettono di giocare a quel gioco (o sull'ultimo momento forte). Niente dopo.
- SII SEVERO: di una partita tieni i momenti forti e quello che serve a capirli, NON la partita intera. Tentativi ripetuti, partite normali senza niente di divertente, commenti tecnici sul gioco si tolgono. Nel dubbio si taglia.
- DURATA: quella che serve, ma di solito un'ora di live diventa 20-28 minuti (circa un terzo, mai oltre il 45%). Un montaggio che tiene più di metà è troppo lungo (simo, 2026-09-28: da 60 a 36 minuti era "un goccio assai").
- TAGLI PULITI: ogni tratto inizia all'inizio di una frase e finisce alla fine di una frase (usa i tempi delle righe). Ogni tratto dura almeno 8 secondi; due tratti separati da meno di 4 secondi uniscili.

INTRO "IN QUESTO VIDEO"
Proponi 4 momenti candidati (ne verranno usati 2) per l'intro: le REAZIONI più folli del video, dove qualcuno URLA, insulta, bestemmia, sclera o ride fortissimo. Devono colpire anche senza contesto e venire da punti diversi del video, dentro i tratti tenuti.
- Sceglili dal TESTO: esclamazioni, insulti, "NOOO", risate, frasi urlate. MAI un momento in cui parlano normale (spiegano, commentano la squadra, leggono i nomi), anche se nel gioco succede qualcosa: si deve SENTIRE la loro reazione.
- NON fidarti dei "momenti in cui alzano la voce": sono misurati su tutto l'audio e contengono anche musica della lobby, spari e avvisi degli abbonamenti.
- Per ognuno copia in "quote" le parole ESATTE della reazione (3-8 parole consecutive della trascrizione), così si trova il punto preciso; start/end sono i tempi della riga in cui sta.

Rispondi chiamando lo strumento ${TOOL_NAME}.`;

const TOOL_SCHEMA: Anthropic.Tool = {
  name: TOOL_NAME,
  description: "Restituisce il montaggio: i tratti da tenere in ordine e i momenti dell'intro.",
  input_schema: {
    type: "object",
    properties: {
      keep: {
        type: "array",
        description: "Tratti da tenere, in ordine di tempo.",
        items: {
          type: "object",
          properties: {
            start: { type: "number", description: "Secondi dall'inizio del pezzo." },
            end: { type: "number" },
            why: { type: "string", description: "Cosa succede, in poche parole." },
          },
          required: ["start", "end"],
        },
      },
      intro: {
        type: "array",
        description: "4 reazioni candidate per l'intro (urla, insulti, risate), dalla più forte.",
        items: {
          type: "object",
          properties: {
            start: { type: "number", description: "Inizio della riga della trascrizione." },
            end: { type: "number" },
            quote: { type: "string", description: "Le parole esatte della reazione, 3-8 parole consecutive copiate dalla trascrizione." },
            why: { type: "string" },
          },
          required: ["start", "end", "quote"],
        },
      },
      endReason: { type: "string", description: "Perché il video finisce dove finisce." },
    },
    required: ["keep", "intro"],
  },
};

/** Sonnet 5 a volte restituisce liste e oggetti annidati come testo JSON. */
function parseJsonText(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const rangeSchema = z.object({ start: z.coerce.number(), end: z.coerce.number(), why: z.string().optional() });
const introSchema = rangeSchema.extend({ quote: z.string().default("") });
const responseSchema = z.object({
  keep: z.preprocess(parseJsonText, z.array(z.preprocess(parseJsonText, rangeSchema))),
  intro: z.preprocess(parseJsonText, z.array(z.preprocess(parseJsonText, introSchema))).default([]),
  endReason: z.string().optional(),
});

/**
 * Chiede all'AI il montaggio. `segments` e `loudMoments` sono in secondi dall'inizio del pezzo.
 * null se l'AI non risponde in modo usabile: il chiamante ripiega sul montaggio solo-silenzi.
 */
export async function planHighlights(
  input: { title: string; durationSeconds: number; segments: TranscriptSegment[]; loudMoments: number[] },
  options: { apiKey: string; model: string },
): Promise<HighlightsPlan | null> {
  const lines = input.segments
    .filter((s) => s.end > 0 && s.start < input.durationSeconds)
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`)
    .join("\n");
  if (!lines) return null;
  const loud = input.loudMoments.length ? input.loudMoments.map((t) => t.toFixed(0)).join(", ") : "nessuno misurato";
  const text = `Titolo del video: ${input.title}\nDurata del pezzo: ${Math.round(input.durationSeconds)} secondi\nMomenti in cui qualcuno alza molto la voce (secondi): ${loud}\n\nTrascrizione:\n${lines}`;

  const usage: ModelTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  try {
    const client = getAnthropicClient(options.apiKey);
    const message = await client.messages.create({
      model: options.model,
      max_tokens: 16000,
      system: cachedSystemPrompt(SYSTEM_PROMPT),
      messages: [{ role: "user", content: text }],
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
      logger.warn("Montaggio da YouTuber: risposta illeggibile", {
        stopReason: message.stop_reason,
        input: toolUse ? JSON.stringify(toolUse.input).slice(0, 600) : null,
      });
      return null;
    }
    logger.info("Montaggio da YouTuber: piano dell'AI", {
      tratti: parsed.data.keep.length,
      intro: parsed.data.intro.map((r) => `${r.start.toFixed(1)}-${r.end.toFixed(1)} "${r.quote}" ${r.why ?? ""}`),
      fine: parsed.data.endReason,
    });
    return {
      keep: parsed.data.keep.map((r) => ({ start: r.start, end: r.end })),
      intro: parsed.data.intro.filter((r) => r.quote.trim()).map((r) => ({ start: r.start, end: r.end, quote: r.quote })),
    };
  } catch (error) {
    logger.warn("Montaggio da YouTuber fallito", { error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    const tier = classifyModelTier(options.model) ?? "sonnet";
    if (usage.calls > 0) logger.info("Costo REALE misurato — montaggio da YouTuber", { model: options.model, ...usage, costUsd: computeModelCostUsd(tier, usage).toFixed(4) });
  }
}

const TIGHTEN_TOOL = "accorcia_montaggio";
/** Voto massimo di un pezzo che si può togliere per accorciare. */
const WEAK_SCORE = 4;

const TIGHTEN_PROMPT = `Sei il montatore di un canale YouTube italiano che ripubblica le live di streamer. Hai già montato un video, ma è troppo lungo. Ricevi i pezzi tenuti, numerati, con il loro testo. Dai a OGNI pezzo un voto da 1 a 10 su quanto è forte per il video: poi si tolgono i pezzi col voto più basso finché si arriva alla durata obiettivo.

- Voti bassi (1-4): partite normali, spiegazioni, commenti tecnici, tentativi ripetuti, pezzi che non fanno ridere né arrabbiare.
- Voti alti (8-10): i momenti che fanno ridere, sclerare, arrabbiare; le vittorie e le sconfitte che contano.
- Il setup che serve a capire un momento forte prende lo stesso voto del momento.
- Usa tutta la scala: i voti devono separare davvero i pezzi, non tutti 6-7.

Rispondi chiamando lo strumento ${TIGHTEN_TOOL}.`;

const TIGHTEN_SCHEMA: Anthropic.Tool = {
  name: TIGHTEN_TOOL,
  description: "Restituisce il voto di ogni pezzo.",
  input_schema: {
    type: "object",
    properties: {
      scores: {
        type: "array",
        description: "Un voto per ogni pezzo.",
        items: { type: "object", properties: { piece: { type: "integer" }, score: { type: "number" } }, required: ["piece", "score"] },
      },
    },
    required: ["scores"],
  },
};

const tightenSchema = z.object({
  scores: z.preprocess(parseJsonText, z.array(z.preprocess(parseJsonText, z.object({ piece: z.coerce.number().int(), score: z.coerce.number() })))),
});

/**
 * Secondo giro quando il montaggio resta troppo lungo (simo, 2026-09-28: da 60 a 32 minuti era
 * ancora "un goccio assai" anche dopo aver chiesto all'AI 20-28 minuti). L'AI rilegge SOLO i pezzi
 * tenuti e dà un voto a ognuno; poi si tolgono i più deboli finché si arriva all'obiettivo. Prima le
 * si chiedeva quali togliere, ma ne toglieva 3 su 20 e restava 32 minuti. Ritorna i pezzi rimasti, o
 * null se fallisce.
 */
export async function tightenHighlights(
  input: { title: string; pieces: Array<HighlightsRange & { text: string }>; targetSeconds: number },
  options: { apiKey: string; model: string },
): Promise<HighlightsRange[] | null> {
  const total = input.pieces.reduce((sum, p) => sum + (p.end - p.start), 0);
  const list = input.pieces.map((p, i) => `#${i} [${Math.round(p.end - p.start)} s] ${p.text.trim().slice(0, 1500)}`).join("\n");
  const text = `Titolo del video: ${input.title}\nDurata attuale: ${Math.round(total / 60)} minuti. Obiettivo: circa ${Math.round(input.targetSeconds / 60)} minuti (togli circa ${Math.round((total - input.targetSeconds) / 60)} minuti).\n\nPezzi tenuti:\n${list}`;
  const usage: ModelTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  try {
    const client = getAnthropicClient(options.apiKey);
    const message = await client.messages.create({
      model: options.model,
      max_tokens: 4000,
      system: cachedSystemPrompt(TIGHTEN_PROMPT),
      messages: [{ role: "user", content: text }],
      tools: [TIGHTEN_SCHEMA],
      tool_choice: toolChoiceFor(options.model, TIGHTEN_TOOL),
    });
    usage.calls++;
    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    const cache = readCacheUsage(message.usage);
    usage.cacheRead += cache.cacheRead;
    usage.cacheWrite += cache.cacheWrite;
    const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TIGHTEN_TOOL);
    const parsed = toolUse ? tightenSchema.safeParse(toolUse.input) : null;
    if (!parsed?.success) return null;
    const score = new Map(parsed.data.scores.map((x) => [x.piece, x.score]));
    const last = input.pieces.length - 1;
    // Dal più debole al più forte (a parità, il più lungo prima); la fine del video resta sempre.
    const order = input.pieces
      .map((p, i) => ({ i, len: p.end - p.start, score: score.get(i) ?? 5 }))
      .filter((x) => x.i !== last)
      .sort((a, b) => a.score - b.score || b.len - a.len);
    const remove = new Set<number>();
    let left = total;
    for (const x of order) {
      if (left <= input.targetSeconds) break;
      // Solo pezzi davvero deboli: se non resta niente di debole si lascia così (simo, 2026-09-28:
      // "se non ha più nulla da tagliare lasciamo così").
      if (x.score > WEAK_SCORE) break;
      remove.add(x.i);
      left -= x.len;
    }
    const kept = input.pieces.filter((_, i) => !remove.has(i)).map((p) => ({ start: p.start, end: p.end }));
    logger.info("Montaggio da YouTuber: secondo giro per accorciare", {
      prima: Math.round(total),
      dopo: Math.round(kept.reduce((sum, p) => sum + (p.end - p.start), 0)),
      obiettivo: Math.round(input.targetSeconds),
      tolti: remove.size,
    });
    return kept;
  } catch (error) {
    logger.warn("Secondo giro del montaggio fallito", { error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    const tier = classifyModelTier(options.model) ?? "sonnet";
    if (usage.calls > 0) logger.info("Costo REALE misurato — accorcia montaggio", { model: options.model, ...usage, costUsd: computeModelCostUsd(tier, usage).toFixed(4) });
  }
}

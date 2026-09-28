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
  /** Momenti dell'intro (2, al massimo 3), nello stesso riferimento. */
  intro: HighlightsRange[];
}

const TOOL_NAME = "monta_video";

const SYSTEM_PROMPT = `Sei il montatore di un canale YouTube italiano che ripubblica le live di streamer (Blur, Marza, Pesh, Manuxo, Lollo...). Ricevi la trascrizione con i tempi (secondi dall'inizio del pezzo) di un pezzo di live dedicato a UN argomento, di solito un gioco, e i momenti in cui qualcuno alza molto la voce, misurati sull'audio vero. Devi montarlo come fanno gli YouTuber che fanno milioni di visualizzazioni.

COSA TENERE E COSA TOGLIERE
- UN SOLO ARGOMENTO: il video parla solo di quello del titolo. Se in mezzo parlano d'altro (leggono la chat su altri temi, parlano di altri giochi, di soldi, di sponsor, di cosa mangiano) e poi tornano al gioco, quel pezzo si toglie TUTTO.
- VIA LE PARTI MORTE: attese, caricamenti, menu, silenzi, "vabbè", tentativi ripetuti uguali senza niente di divertente, chiacchiere che non portano a niente.
- TIENI i momenti che fanno ridere, arrabbiare o stupire, CON il loro contesto: il setup che serve a capire la battuta, la battuta, la reazione. Mai la sola frase finale staccata dal resto.
- FINE: il video finisce quando smettono di giocare a quel gioco (o sull'ultimo momento forte). Niente dopo.
- DURATA: quella che serve, non allungare e non tagliare per arrivare a un numero. Di solito resta tra un quarto e metà dell'originale.
- TAGLI PULITI: ogni tratto inizia all'inizio di una frase e finisce alla fine di una frase (usa i tempi delle righe). Ogni tratto dura almeno 8 secondi; due tratti separati da meno di 4 secondi uniscili.

INTRO "IN QUESTO VIDEO"
Scegli 2 momenti (al massimo 3) cortissimi, 2-5 secondi l'uno, al massimo 10 secondi in tutto: i più folli del video, dove urlano, insultano, sclerano, ridono fortissimo. Devono colpire anche senza contesto. MAI un momento in cui restano zitti, anche se nel gioco succede qualcosa (li uccidono, vincono): nell'intro deve sentirsi la loro voce forte, meglio se un momento cade vicino a uno dei momenti in cui alzano la voce elencati sopra. Devono stare dentro i tratti tenuti (li si rivedrà nel video) e venire da punti diversi del video.

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
        description: "2 (massimo 3) momenti cortissimi per l'intro, 2-5 s l'uno, massimo 10 s in tutto.",
        items: {
          type: "object",
          properties: { start: { type: "number" }, end: { type: "number" }, why: { type: "string" } },
          required: ["start", "end"],
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
const responseSchema = z.object({
  keep: z.preprocess(parseJsonText, z.array(z.preprocess(parseJsonText, rangeSchema))),
  intro: z.preprocess(parseJsonText, z.array(z.preprocess(parseJsonText, rangeSchema))).default([]),
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
      intro: parsed.data.intro.map((r) => `${r.start.toFixed(1)}-${r.end.toFixed(1)} ${r.why ?? ""}`),
      fine: parsed.data.endReason,
    });
    return {
      keep: parsed.data.keep.map((r) => ({ start: r.start, end: r.end })),
      intro: parsed.data.intro.map((r) => ({ start: r.start, end: r.end })),
    };
  } catch (error) {
    logger.warn("Montaggio da YouTuber fallito", { error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    const tier = classifyModelTier(options.model) ?? "sonnet";
    if (usage.calls > 0) logger.info("Costo REALE misurato — montaggio da YouTuber", { model: options.model, ...usage, costUsd: computeModelCostUsd(tier, usage).toFixed(4) });
  }
}

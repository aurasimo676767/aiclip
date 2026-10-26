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
  /** Pezzi in cui passano a un altro argomento, con le parole esatte di quando se ne vanno e di quando tornano. */
  topicChanges: Array<{ leaveAt: number; leaveQuote: string; returnAt: number; returnQuote: string }>;
  /** Primi piani sulla webcam: solo reazioni forti ("sclero"), con le parole esatte. "frase" resta solo per leggere i piani vecchi e si scarta. */
  closeups: Array<HighlightsRange & { quote: string; kind: "sclero" | "frase" }>;
}

const TOOL_NAME = "monta_video";

const SYSTEM_PROMPT = `Sei il montatore di un canale YouTube italiano che ripubblica le live di streamer (Blur, Marza, Pesh, Manuxo, Lollo...). Ricevi la trascrizione con i tempi (secondi dall'inizio del pezzo) di un pezzo di live dedicato a UN argomento, di solito un gioco, i momenti in cui qualcuno alza molto la voce misurati sull'audio vero e, quando c'è, cosa si vede A SCHERMO (partita, inizio o fine di una partita, menu, caricamento) con gli stessi tempi. Devi montarlo come fanno gli YouTuber che fanno milioni di visualizzazioni.

COSA TENERE E COSA TOGLIERE
- UN SOLO ARGOMENTO: il video parla solo di quello del titolo. Se in mezzo parlano d'altro (leggono la chat su altri temi, parlano di altri giochi, di soldi, di sponsor, di cosa mangiano) e poi tornano al gioco, quel pezzo si toglie TUTTO.
- SI DEVE VEDERE CHE GIOCANO (simo, 2026-10-26): il video è fatto soprattutto di PARTITE. Menu, lobby, caricamenti, attese e tutorial restano solo per pochi secondi (al massimo una quindicina di fila), quanto basta a capire il passaggio, oppure se dentro c'è un momento davvero divertente (risate, sclero). Usa la parte "A SCHERMO" per sapere dove sono.
- INIZIO DEL VIDEO: una breve presentazione, al massimo mezzo minuto: il momento in cui dicono a cosa giocano o lo scelgono ("dai andiamo a giocare a...", "andiamo in quel gioco di merda", la scelta del gioco, la ruota). Poi la prima partita parte quasi subito.
- OGNI PARTITA o ROUND che tieni si vede COMINCIARE (schermata d'inizio, "Via!", primi secondi) e FINIRE (ultimo punto, schermata di vittoria, sconfitta o risultato). In mezzo puoi tagliare, tenendo i momenti forti. Ogni gioco o minigioco a cui giocano ha almeno una partita così.
- NON PERDERE IL FILO: chi guarda deve capire a cosa stanno giocando, chi vince e come va.
- VIA LE PARTI MORTE: attese, caricamenti, menu, silenzi, "vabbè", tentativi ripetuti uguali senza niente di divertente, chiacchiere che non portano a niente.
- TIENI i momenti che fanno ridere, arrabbiare o stupire, CON il loro contesto: il setup che serve a capire la battuta, la battuta, la reazione. Mai la sola frase finale staccata dal resto.
- FINE: il video finisce quando smettono di giocare a quel gioco (o sull'ultimo momento forte). Niente dopo. Le ULTIME partite, fino alla vittoria o sconfitta finale, restano sempre: sono il finale del video.
- SII SEVERO: di una partita tieni l'inizio, la fine e i momenti forti con quello che serve a capirli, NON la partita intera. Tentativi ripetuti, partite normali senza niente di divertente, commenti tecnici sul gioco si tolgono. Nel dubbio si taglia.
- DURATA: NESSUN numero di minuti da raggiungere (simo, 2026-10-26: un video di 2 ore e mezza portato a 45 minuti esatti era forzato). Tieni solo quello che è forte o che serve a capire, e taglia il più possibile il resto: se c'è poco di forte il video viene corto, ed è giusto così. Su un pezzo lungo tieni i momenti forti distribuiti su tutto il gioco (come comincia, i momenti migliori, come va a finire). Se togli un pezzo in cui fanno altro, NON tagliare il resto per compensare.
- TAGLI PULITI: ogni tratto inizia all'inizio di una frase e finisce alla fine di una frase (usa i tempi delle righe). Ogni tratto dura almeno 8 secondi; due tratti separati da meno di 4 secondi uniscili.
- CAMBI DI ARGOMENTO: quando togli un pezzo in cui fanno altro (un altro gioco, altro), il taglio parte ESATTAMENTE dove lasciano il gioco del video (la frase in cui lanciano l'altro gioco o cambiano discorso) e riprende esattamente dove ci tornano. Non tagliare anche la fine della partita prima del cambio, se non è davvero morta. Elenca ogni cambio in "topicChanges" con le parole esatte di quando se ne vanno e di quando tornano (se non tornano più, il video finisce lì e basta).

INTRO "IN QUESTO VIDEO"
Proponi 4 momenti candidati (ne verranno usati 2) per l'intro: le REAZIONI più folli del video, dove qualcuno URLA, insulta, bestemmia, sclera o ride fortissimo. Devono colpire anche senza contesto e venire da punti diversi del video, SOLO da tratti che tieni (se un momento è così forte da finire nell'intro, quel pezzo va tenuto).
- SOLO URLA: raffiche di bestemmie, insulti urlati, "NOOO", risate fortissime. NON battute o frasi divertenti dette a voce normale (quelle vanno nei primi piani): a simo è piaciuta l'intro con la raffica di "porco dio", non quella con le frasi.
- Sceglili dal TESTO: esclamazioni, insulti, "NOOO", risate, frasi urlate. MAI un momento in cui parlano normale (spiegano, commentano la squadra, leggono i nomi), anche se nel gioco succede qualcosa: si deve SENTIRE la loro reazione.
- NON fidarti dei "momenti in cui alzano la voce": sono misurati su tutto l'audio e contengono anche musica della lobby, spari e avvisi degli abbonamenti.
- Per ognuno copia in "quote" le parole ESATTE della reazione (3-8 parole consecutive della trascrizione), così si trova il punto preciso; start/end sono i tempi della riga in cui sta.

PRIMI PIANI SULLA WEBCAM
Sono lo stacco sulla webcam di chi REAGISCE, come negli edit degli YouTuber. SOLO sulle reazioni FORTI (simo, 2026-10-26: gli zoom su frasi normali "non hanno senso"):
- quando si incazzano DAVVERO (bestemmie a raffica, insulti urlati, rage), urlano per qualcosa che è appena successo nel gioco ("NOOO", "MA COME", un punto perso, una vittoria), o esplodono a ridere. Non ogni bestemmia: bestemmiano sempre, scegli i picchi.
- MAI su frasi dette a voce normale: battute, commenti, domande, prese in giro tranquille, spiegazioni, anche se lette sembrano divertenti. Se non è un urlo o una risata esplosa, non è un primo piano.
Nessun numero minimo: meglio nessun primo piano che uno debole. Al massimo uno ogni 45 secondi circa di video montato, SOLO dentro i tratti che tieni.
Per ognuno kind "sclero", e in "quote" copia le parole ESATTE della reazione (3-12 parole consecutive della trascrizione) dal suo inizio; start/end sono i tempi della riga.

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
      topicChanges: {
        type: "array",
        description: "Pezzi tolti perché fanno altro: dove se ne vanno e dove tornano, con le parole esatte.",
        items: {
          type: "object",
          properties: {
            leaveAt: { type: "number", description: "Inizio della riga in cui lasciano il gioco del video." },
            leaveQuote: { type: "string", description: "Le parole esatte con cui cambiano (3-10 parole)." },
            returnAt: { type: "number", description: "Inizio della riga in cui tornano." },
            returnQuote: { type: "string", description: "Le parole esatte con cui tornano (3-10 parole)." },
          },
          required: ["leaveAt", "leaveQuote", "returnAt", "returnQuote"],
        },
      },
      closeups: {
        type: "array",
        description: "Primi piani sulla webcam di chi reagisce: SOLO reazioni forti (urla, rage, risate esplose). Può essere vuoto.",
        items: {
          type: "object",
          properties: {
            start: { type: "number", description: "Inizio della riga della trascrizione." },
            end: { type: "number" },
            kind: { type: "string", enum: ["sclero"] },
            quote: { type: "string", description: "Le parole esatte della reazione, dal suo inizio." },
          },
          required: ["start", "end", "kind", "quote"],
        },
      },
      endReason: { type: "string", description: "Perché il video finisce dove finisce." },
    },
    required: ["keep", "intro", "topicChanges", "closeups"],
  },
};

/** Sonnet 5 a volte restituisce liste e oggetti annidati come testo JSON. */
function parseJsonText(v: unknown): unknown {
  let out = v;
  if (typeof out === "string") {
    try {
      out = JSON.parse(out);
    } catch {
      return v;
    }
  }
  // A volte la lista arriva dentro un oggetto con una sola chiave (visto il 2026-09-28:
  // keep = "{\"segments\":[...]}"): si prende la lista, invece di scartare tutto il piano.
  if (out && typeof out === "object" && !Array.isArray(out)) {
    const values = Object.values(out as Record<string, unknown>);
    if (values.length === 1 && Array.isArray(values[0])) return values[0];
  }
  return out;
}

const rangeSchema = z.object({ start: z.coerce.number(), end: z.coerce.number(), why: z.string().optional() });
const introSchema = rangeSchema.extend({ quote: z.string().default("") });
const responseSchema = z.object({
  keep: z.preprocess(parseJsonText, z.array(z.preprocess(parseJsonText, rangeSchema))),
  intro: z.preprocess(parseJsonText, z.array(z.preprocess(parseJsonText, introSchema))).default([]),
  topicChanges: z
    .preprocess(
      parseJsonText,
      z.array(z.preprocess(parseJsonText, z.object({ leaveAt: z.coerce.number(), leaveQuote: z.string(), returnAt: z.coerce.number(), returnQuote: z.string() }))),
    )
    .default([]),
  closeups: z
    .preprocess(parseJsonText, z.array(z.preprocess(parseJsonText, introSchema.extend({ kind: z.enum(["sclero", "frase"]).catch("frase") }))))
    .default([]),
  endReason: z.string().optional(),
});

/**
 * Chiede all'AI il montaggio. `segments` e `loudMoments` sono in secondi dall'inizio del pezzo.
 * null se l'AI non risponde in modo usabile: il chiamante ripiega sul montaggio solo-silenzi.
 */
export async function planHighlights(
  input: {
    title: string;
    durationSeconds: number;
    segments: TranscriptSegment[];
    loudMoments: number[];
    note?: string;
    /** Cosa c'è a schermo, a righe "[da-a] fase gioco" (vedi match-phases.ts). */
    screen?: string;
  },
  options: { apiKey: string; model: string },
): Promise<HighlightsPlan | null> {
  const lines = input.segments
    .filter((s) => s.end > 0 && s.start < input.durationSeconds)
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`)
    .join("\n");
  if (!lines) return null;
  const loud = input.loudMoments.length ? input.loudMoments.map((t) => t.toFixed(0)).join(", ") : "nessuno misurato";
  const screen = input.screen ? `\n\nA SCHERMO (un fotogramma ogni 10 secondi, stessi tempi della trascrizione):\n${input.screen}` : "";
  const text = `Titolo del video: ${input.title}\nDurata del pezzo: ${Math.round(input.durationSeconds)} secondi\nMomenti in cui qualcuno alza molto la voce (secondi): ${loud}${input.note ? `\n\n${input.note}` : ""}${screen}\n\nTrascrizione:\n${lines}`;

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
      cambiArgomento: parsed.data.topicChanges.map((c) => `${c.leaveAt.toFixed(0)} "${c.leaveQuote}" → ${c.returnAt.toFixed(0)} "${c.returnQuote}"`),
      primiPiani: parsed.data.closeups.length,
    });
    return {
      keep: parsed.data.keep.map((r) => ({ start: r.start, end: r.end })),
      intro: parsed.data.intro.filter((r) => r.quote.trim()).map((r) => ({ start: r.start, end: r.end, quote: r.quote })),
      topicChanges: parsed.data.topicChanges,
      closeups: parsed.data.closeups.filter((r) => r.quote.trim()).map((r) => ({ start: r.start, end: r.end, quote: r.quote, kind: r.kind })),
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

const TIGHTEN_PROMPT = `Sei il montatore di un canale YouTube italiano che ripubblica le live di streamer. Hai già montato un video e ora va asciugato. Ricevi i pezzi tenuti, numerati, con il loro testo. Dai a OGNI pezzo un voto da 1 a 10 su quanto è forte per il video: poi si tolgono TUTTI i pezzi deboli (voto 4 o meno). Non c'è una durata da raggiungere: il video dura quello che resta di forte.

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
 * Secondo giro, sempre (simo, 2026-09-28: da 60 a 32 minuti era ancora "un goccio assai"). L'AI
 * rilegge SOLO i pezzi tenuti e dà un voto a ognuno; poi si tolgono tutti i deboli. Prima le si
 * chiedeva quali togliere, ma ne toglieva 3 su 20. Niente durata obiettivo né tetto (simo,
 * 2026-10-26: 2 ore e mezza portate a 45 minuti esatti era forzato): "taglia il più possibile", ma
 * solo ciò che è debole ("se non ha più nulla da tagliare lasciamo così", 2026-09-28). Il primo pezzo
 * (la presentazione) e l'ultimo (il finale) restano. Ritorna i pezzi rimasti, o null se fallisce.
 */
export async function tightenHighlights(
  input: {
    title: string;
    pieces: Array<HighlightsRange & { text: string }>;
  },
  options: { apiKey: string; model: string },
): Promise<HighlightsRange[] | null> {
  const total = input.pieces.reduce((sum, p) => sum + (p.end - p.start), 0);
  const list = input.pieces.map((p, i) => `#${i} [${Math.round(p.end - p.start)} s] ${p.text.trim().slice(0, 1500)}`).join("\n");
  const text = `Titolo del video: ${input.title}\nDurata attuale: ${Math.round(total / 60)} minuti.\n\nPezzi tenuti:\n${list}`;
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
    const remove = new Set(input.pieces.map((_, i) => i).filter((i) => i !== 0 && i !== last && (score.get(i) ?? 5) <= WEAK_SCORE));
    const kept = input.pieces.filter((_, i) => !remove.has(i)).map((p) => ({ start: p.start, end: p.end }));
    logger.info("Montaggio da YouTuber: secondo giro per accorciare", {
      prima: Math.round(total),
      dopo: Math.round(kept.reduce((sum, p) => sum + (p.end - p.start), 0)),
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

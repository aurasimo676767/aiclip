import { z } from "zod";
import type { TranscriptSegment } from "@clipforge/shared";
import { clipCandidateSchema, type ClipCandidatesResponse } from "@clipforge/shared";
import { CANDIDATE_CHUNK_OVERLAP_SECONDS, CANDIDATE_CHUNK_WINDOW_SECONDS, CLIP_DURATION_TARGET } from "@clipforge/shared";
import { getAnthropicClient, cachedSystemPrompt, logAnthropicCost } from "./anthropic-client.js";
import { formatSegments, segmentsInWindow } from "./transcript-formatting.js";
import type { LoudMoment } from "../../pipeline/vocal-energy.js";
import { logger } from "../../lib/logger.js";

// Estrae solo l'array grezzo (senza validare ancora ogni candidato): serve a distinguere un
// output strutturalmente sbagliato (niente "candidates", o non è un array — lì la finestra va
// scartata per intero) da un array valido i cui singoli elementi vanno controllati uno per uno.
const candidatesContainerSchema = z.object({ candidates: z.array(z.unknown()).max(50) });

const TOOL_NAME = "return_clip_candidates";

const CANDIDATES_TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Restituisce le finestre candidate individuate nel transcript per potenziali YouTube Shorts.",
  input_schema: {
    type: "object" as const,
    properties: {
      candidates: {
        type: "array",
        maxItems: 15,
        items: {
          type: "object",
          properties: {
            start: {
              type: "number",
              description:
                "Timestamp di inizio in secondi dall'inizio del video — DEVE cadere esattamente all'inizio della frase-gancio (vedi 'hook'), MAI prima. Scarta tutto il setup/contesto che la precede nel parlato originale, anche se rilevante: chi guarda deve capire il succo entro le prime 3 parole, non dopo un preambolo.",
            },
            end: { type: "number", description: "Timestamp di fine in secondi dall'inizio del video." },
            hook: {
              type: "string",
              description:
                "Le PRIME parole effettive della clip (non una descrizione del momento): devono essere già il contenuto forte — l'affermazione sorprendente/assurda, la reazione esplosiva, il numero scioccante — non l'introduzione che porta ad esso.",
            },
            reason: { type: "string", description: "Perché questo momento funzionerebbe come clip virale, in una frase." },
          },
          required: ["start", "end", "hook", "reason"],
        },
      },
    },
    required: ["candidates"],
  },
};

const SYSTEM_PROMPT = `Sei un editor di YouTube Shorts di un canale di clip di streamer italiani. Il tuo lavoro è trovare TUTTI i momenti di questa finestra che possono diventare uno Short divertente: un secondo passaggio farà il controllo qualità finale, quindi qui un momento buono perso è un errore molto più grave di un candidato in più (simo, 2026-10-25: "deve trovare TUTTE le clip divertenti di ogni video, soprattutto le parti dove urlano, bestemmiano, muoiono dalle risate").

Sono candidati, da proporre SEMPRE:
- qualcuno che urla, sbrocca, si infuria, va in panico o esplode di scatto
- bestemmie, insulti e parolacce dette di getto in una reazione (l'audio può averle, il titolo pulito lo scrive un altro passaggio)
- risate a crepapelle, qualcuno che non riesce a smettere di ridere, che piange dal ridere
- battute, prese in giro, figuracce, momenti di imbarazzo
- litigi, botta e risposta accesi, opinioni assurde o controverse dette con convinzione
- storie assurde, fatti sorprendenti, svolte inaspettate
- reazioni forti a un video, un TikTok, una partita, una giocata

Scarta solo:
- chiacchiere tranquille in cui non succede niente
- tratti in cui lo streamer sta zitto e si sente solo il gioco o il video
- inizi lenti, finali troncati a metà frase, pause morte

Nel dubbio proponi il candidato: deciderà il passaggio successivo, che vede anche i fotogrammi.

DOVE INIZIA IL TAGLIO — questa è la parte più importante: la clip NON inizia da dove inizia l'argomento nel discorso originale, inizia dalla frase-gancio stessa. Se lo streamer dice "allora vi devo raccontare una cosa, ieri ho letto che a volte le aragoste perdono le zampe quando sono stressate", il taglio comincia da "a volte le aragoste perdono le zampe...", NON da "allora vi devo raccontare" — quel setup va scartato anche se nel parlato originale veniva prima e dava contesto. Entro le prime 3 parole della clip deve già iniziare il succo. Segnali di una buona frase-gancio, in ordine di priorità:
1. Affermazione controintuitiva o fatto sorprendente/assurdo
2. Reazione emotiva forte e improvvisa (shock, urla, risata esplosiva) — un cambio di tono brusco rispetto a quello che c'era prima nel transcript è un segnale forte
3. Frase con un numero o una statistica sorprendente
4. Svolta/rivelazione che ribalta quello che si pensava un attimo prima
Il campo "hook" deve contenere le parole ESATTE con cui la clip si apre, non un riassunto — e "start" deve corrispondere al timestamp di quelle parole, non a quello del preambolo che le precede.

MOMENTI URLATI — usa questo segnale: quando nel messaggio ti vengono indicati dei "momenti in cui qualcuno alza nettamente la voce", sono misurati sull'audio VERO, non dedotti dal testo. Sono il segnale più affidabile che hai per capire dove il video si accende davvero: qualcuno che urla, si infuria, esplode a ridere o reagisce di scatto è esattamente ciò che tiene incollato uno spettatore su uno Short, e leggendo il solo transcript quel momento sembra una frase qualunque. Vai a controllare per primi quei punti: quasi sempre lì attorno c'è un candidato, spesso il migliore della finestra. Per ogni gruppo di urla proponi il momento che le contiene, partendo dalla frase che le provoca, a meno che sia rumore senza nessuno che reagisca (un alert, un suono del gioco).

DOVE FINISCE IL TAGLIO — ERRORE DA NON RIPETERE (osservato in produzione): tagliare "senza pietà" NON significa fermarsi subito dopo la frase-gancio. Una clip che è solo hook e poi finisce di colpo non fa ridere/non colpisce, perché manca lo sviluppo: la reazione di chi ascolta, la battuta che segue, l'escalation, la spiegazione che rende la cosa ancora più assurda. "end" deve includere tutto questo, non solo il gancio: chiudi quando la storia è finita (battuta, reazione, rivelazione), non il prima possibile. LA DURATA LA DECIDE LA STORIA: una battuta secca sta in 20-30 s, una storia o una reaction con setup, sviluppo e finale di solito sta sotto ${CLIP_DURATION_TARGET.max} s; fino a ${CLIP_DURATION_TARGET.hardMax} s SOLO se è forte dall'inizio alla fine. Non allungare MAI con chiacchiere, rilanci o tempi morti per arrivare a una durata: uno Short da 25 s tutto pieno batte uno da 55 s con 20 s di vuoto. Il "taglia senza pietà" si applica al SETUP prima del gancio e ai momenti morti in mezzo, MAI al payoff dopo.

Ogni clip candidata deve durare al massimo ${CLIP_DURATION_TARGET.hardMax} secondi e almeno ${CLIP_DURATION_TARGET.min} — non fermarti prima solo perché il gancio è già stato detto. Se il momento naturale attorno al gancio (gancio + sviluppo/payoff) è più lungo del tetto, allora sì taglia aggressivamente per starci dentro, ma sempre preferendo tenere il payoff piuttosto che tagliarlo per accorciare. Usa ESCLUSIVAMENTE i timestamp presenti nel transcript fornito: non inventare tempi. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

export interface CandidateDetectionOptions {
  apiKey: string;
  model: string;
  videoTitle: string;
  videoDurationSeconds: number;
  /**
   * Momenti in cui le voci si alzano nettamente (urla, reazioni concitate) — vedi
   * vocal-energy.ts. Il transcript dice COSA viene detto ma non COME: una battuta urlata e una
   * detta piano hanno lo stesso testo, e per uno Short la differenza è enorme. Passati al
   * modello come indizio su dove guardare, non come vincolo.
   */
  loudMoments?: LoudMoment[];
}

/**
 * Passaggio economico (modello cheap, es. Claude Haiku): chunka il transcript in finestre
 * di ~10 minuti con overlap e chiede candidati per ciascuna finestra, per contenere sia il
 * numero di token per chiamata sia il rischio di perdere momenti a cavallo di un confine.
 */
export async function detectClipCandidates(
  segments: TranscriptSegment[],
  options: CandidateDetectionOptions,
): Promise<ClipCandidatesResponse["candidates"]> {
  const client = getAnthropicClient(options.apiKey);
  const windows = buildWindows(options.videoDurationSeconds);
  const allCandidates: ClipCandidatesResponse["candidates"] = [];

  for (const window of windows) {
    const windowSegments = segmentsInWindow(segments, window.start, window.end);
    if (windowSegments.length === 0) continue;

    const loudHere = (options.loudMoments ?? []).filter((m) => m.end > window.start && m.start < window.end);
    const loudHint =
      loudHere.length > 0
        ? `\nMomenti in cui qualcuno ALZA NETTAMENTE LA VOCE in questa finestra (urla/reazioni concitate, misurati sull'audio reale): ${loudHere
            .map((m) => `${m.start.toFixed(0)}s`)
            .join(", ")}\n`
        : "";

    const userPrompt = `Video: "${options.videoTitle}" (durata totale ${Math.round(options.videoDurationSeconds)}s)
Finestra analizzata: ${window.start.toFixed(0)}s - ${window.end.toFixed(0)}s
${loudHint}
Transcript della finestra:
${formatSegments(windowSegments)}`;

    const message = await client.messages.create({
      model: options.model,
      max_tokens: 3000,
      system: cachedSystemPrompt(SYSTEM_PROMPT),
      messages: [{ role: "user", content: userPrompt }],
      tools: [CANDIDATES_TOOL_SCHEMA],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });
    logAnthropicCost("candidati Shorts", options.model, message.usage);

    const parsed = extractToolInput(message);
    if (!parsed) {
      logger.warn("Nessun output strutturato dal passaggio candidati, finestra saltata", { window });
      continue;
    }

    // Validato in DUE fasi: prima il contenitore (struttura macroscopica), poi ogni candidato
    // singolarmente — un solo campo fuori schema (es. hook/reason troppo lungo) non deve più
    // buttare via TUTTI i candidati validi della finestra insieme a quello incriminato. Prima
    // della fix, un singolo candidato invalido su una finestra intera (fino a 8) faceva
    // scartare l'intera finestra, e se questo capitava su TUTTE le finestre la pipeline falliva
    // del tutto ("L'AI non ha prodotto nessuna clip valida"), triggerando un retry automatico
    // che ripete anche la trascrizione (il passaggio più lento) — osservato in pratica.
    const containerValidation = candidatesContainerSchema.safeParse(parsed);
    if (!containerValidation.success) {
      logger.warn("Output candidati non valido secondo lo schema, finestra saltata", {
        window,
        issues: containerValidation.error.issues,
      });
      continue;
    }

    for (const rawCandidate of containerValidation.data.candidates) {
      const candidateValidation = clipCandidateSchema.safeParse(rawCandidate);
      if (!candidateValidation.success) {
        logger.warn("Candidato singolo non valido, scartato (gli altri della finestra restano validi)", {
          window,
          issues: candidateValidation.error.issues,
        });
        continue;
      }
      allCandidates.push(candidateValidation.data);
    }
  }

  return dedupeCandidates(allCandidates);
}

/** Quanti gruppi di urla al massimo entrano d'ufficio nel ranking (i più forti). */
const MAX_LOUD_FALLBACKS = 10;
/** Urla a meno di così l'una dall'altra sono la stessa scena. */
const LOUD_CLUSTER_GAP_SECONDS = 20;
/** Contesto prima del primo urlo: di solito lì c'è la frase che lo provoca. */
const LOUD_CONTEXT_BEFORE_SECONDS = 12;
const LOUD_CONTEXT_AFTER_SECONDS = 15;

/**
 * Rete di sicurezza (2026-10-25): le urla misurate sull'audio che nessun candidato dell'AI copre
 * entrano comunque nel ranking, con una finestra larga attorno. Con GPT il primo passaggio ne
 * lasciava fuori quasi tutte (un video con 40 momenti urlati, 1 solo candidato): così il controllo
 * finale le vede sempre, con fotogrammi e transcript, e decide lui inizio e fine esatti.
 */
export function addLoudMomentCandidates(
  candidates: ClipCandidatesResponse["candidates"],
  loudMoments: LoudMoment[],
  segments: TranscriptSegment[],
): ClipCandidatesResponse["candidates"] {
  const clusters: LoudMoment[] = [];
  for (const moment of [...loudMoments].sort((a, b) => a.start - b.start)) {
    const last = clusters[clusters.length - 1];
    if (last && moment.start - last.end <= LOUD_CLUSTER_GAP_SECONDS) {
      last.end = Math.max(last.end, moment.end);
      last.aboveBaselineDb = Math.max(last.aboveBaselineDb, moment.aboveBaselineDb);
    } else clusters.push({ ...moment });
  }

  const extra: ClipCandidatesResponse["candidates"] = [];
  const uncovered = clusters
    .filter((c) => !candidates.some((k) => k.start < c.end && k.end > c.start))
    .sort((a, b) => b.aboveBaselineDb - a.aboveBaselineDb)
    .slice(0, MAX_LOUD_FALLBACKS);
  for (const cluster of uncovered) {
    const from = Math.max(0, cluster.start - LOUD_CONTEXT_BEFORE_SECONDS);
    const to = Math.min(cluster.end + LOUD_CONTEXT_AFTER_SECONDS, from + CLIP_DURATION_TARGET.hardMax);
    const inside = segments.filter((s) => s.end > from && s.start < to);
    const first = inside[0];
    const last = inside[inside.length - 1];
    if (!first || !last) continue;
    extra.push({
      start: first.start,
      end: Math.min(last.end, first.start + CLIP_DURATION_TARGET.hardMax),
      hook: first.text.trim().slice(0, 250) || "…",
      reason: `Urla misurate sull'audio (+${cluster.aboveBaselineDb.toFixed(1)} dB sopra il parlato normale) che il primo passaggio non aveva proposto`,
    });
  }
  if (extra.length) logger.info("Momenti urlati aggiunti d'ufficio ai candidati", { count: extra.length, at: extra.map((c) => `${c.start.toFixed(0)}s`) });
  return [...candidates, ...extra].sort((a, b) => a.start - b.start);
}

function buildWindows(durationSeconds: number): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < durationSeconds) {
    const end = Math.min(start + CANDIDATE_CHUNK_WINDOW_SECONDS, durationSeconds);
    windows.push({ start, end });
    if (end >= durationSeconds) break;
    start += CANDIDATE_CHUNK_WINDOW_SECONDS - CANDIDATE_CHUNK_OVERLAP_SECONDS;
  }
  return windows;
}

/** Rimuove candidati quasi-duplicati generati da finestre sovrapposte (stesso start entro pochi secondi). */
function dedupeCandidates(
  candidates: ClipCandidatesResponse["candidates"],
): ClipCandidatesResponse["candidates"] {
  const sorted = [...candidates].sort((a, b) => a.start - b.start);
  const result: ClipCandidatesResponse["candidates"] = [];

  for (const candidate of sorted) {
    const isDuplicate = result.some((existing) => {
      const overlapStart = Math.max(existing.start, candidate.start);
      const overlapEnd = Math.min(existing.end, candidate.end);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const shorter = Math.min(existing.end - existing.start, candidate.end - candidate.start);
      return shorter > 0 && overlap / shorter > 0.6;
    });
    if (!isDuplicate) {
      result.push(candidate);
    }
  }

  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractToolInput(message: { content: any[] }): unknown | null {
  const toolUse = message.content.find((block) => block.type === "tool_use" && block.name === TOOL_NAME);
  return toolUse ? toolUse.input : null;
}

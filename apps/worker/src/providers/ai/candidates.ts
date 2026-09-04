import { z } from "zod";
import type { TranscriptSegment } from "@clipforge/shared";
import { clipCandidateSchema, type ClipCandidatesResponse } from "@clipforge/shared";
import { CANDIDATE_CHUNK_OVERLAP_SECONDS, CANDIDATE_CHUNK_WINDOW_SECONDS, CLIP_DURATION_TARGET } from "@clipforge/shared";
import { getAnthropicClient, cachedSystemPrompt } from "./anthropic-client.js";
import { formatSegments, segmentsInWindow } from "./transcript-formatting.js";
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
        maxItems: 8,
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

const SYSTEM_PROMPT = `Sei un editor di YouTube Shorts esperto e ESIGENTE: il tuo lavoro non è trovare "qualcosa che assomigli a un momento forte", è trovare i pochi momenti che qualcuno condividerebbe davvero in una chat con un amico.

Cerca SOLO momenti con un payoff reale:
- una battuta che fa davvero ridere (non solo un'esclamazione o una parolaccia isolata: serve un punchline, una svolta comica, un'assurdità)
- un'opinione controversa o sorprendente detta con convinzione
- una storia con inizio-sviluppo-fine comprensibile in isolamento
- un momento di imbarazzo, rabbia genuina, o emozione forte con una reazione chiara
- un'informazione utile e concreta, detta in modo diretto

Scarta senza pietà (anche se "suonano" energici):
- frasi rumorose o con parolacce che però non arrivano a un vero payoff comico/narrativo
- momenti che hanno senso solo se conosci già il contesto del gioco/video/persona di cui si parla
- reazioni generiche ("wow", "no dai", risate senza motivo chiaro nel testo) senza una battuta o un fatto concreto dietro
- inizi lenti, finali troncati a metà frase, ripetizioni, pause morte

Il criterio finale: se leggessi solo la trascrizione di questo momento SENZA aver visto il video, capiresti perché è divertente/interessante e vorresti guardarlo? Se la risposta è "boh, forse, se c'eri" — scartalo. È molto meglio restituire 2 candidati davvero forti che 6 mediocri.

DOVE INIZIA IL TAGLIO — questa è la parte più importante: la clip NON inizia da dove inizia l'argomento nel discorso originale, inizia dalla frase-gancio stessa. Se lo streamer dice "allora vi devo raccontare una cosa, ieri ho letto che a volte le aragoste perdono le zampe quando sono stressate", il taglio comincia da "a volte le aragoste perdono le zampe...", NON da "allora vi devo raccontare" — quel setup va scartato anche se nel parlato originale veniva prima e dava contesto. Entro le prime 3 parole della clip deve già iniziare il succo. Segnali di una buona frase-gancio, in ordine di priorità:
1. Affermazione controintuitiva o fatto sorprendente/assurdo
2. Reazione emotiva forte e improvvisa (shock, urla, risata esplosiva) — un cambio di tono brusco rispetto a quello che c'era prima nel transcript è un segnale forte
3. Frase con un numero o una statistica sorprendente
4. Svolta/rivelazione che ribalta quello che si pensava un attimo prima
Il campo "hook" deve contenere le parole ESATTE con cui la clip si apre, non un riassunto — e "start" deve corrispondere al timestamp di quelle parole, non a quello del preambolo che le precede.

DOVE FINISCE IL TAGLIO — ERRORE DA NON RIPETERE (osservato in produzione): tagliare "senza pietà" NON significa fermarsi subito dopo la frase-gancio. Una clip che è solo hook e poi finisce di colpo non fa ridere/non colpisce, perché manca lo sviluppo: la reazione di chi ascolta, la battuta che segue, l'escalation, la spiegazione che rende la cosa ancora più assurda. "end" deve includere tutto questo, non solo il gancio — punta a riempire l'intervallo ${CLIP_DURATION_TARGET.min}-${CLIP_DURATION_TARGET.max}s con contenuto vero (non riempitivo), non a chiudere il prima possibile. Il "taglia senza pietà" si applica al SETUP prima del gancio e ai momenti morti in mezzo, MAI al payoff dopo.

Ogni clip candidata deve durare al massimo ${CLIP_DURATION_TARGET.hardMax} secondi, idealmente ${CLIP_DURATION_TARGET.min}-${CLIP_DURATION_TARGET.max}s — non fermarti prima solo perché il gancio è già stato detto. Se il momento naturale attorno al gancio (gancio + sviluppo/payoff) è più lungo del tetto, allora sì taglia aggressivamente per starci dentro, ma sempre preferendo tenere il payoff piuttosto che tagliarlo per accorciare. Usa ESCLUSIVAMENTE i timestamp presenti nel transcript fornito: non inventare tempi. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

export interface CandidateDetectionOptions {
  apiKey: string;
  model: string;
  videoTitle: string;
  videoDurationSeconds: number;
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

    const userPrompt = `Video: "${options.videoTitle}" (durata totale ${Math.round(options.videoDurationSeconds)}s)
Finestra analizzata: ${window.start.toFixed(0)}s - ${window.end.toFixed(0)}s

Transcript della finestra:
${formatSegments(windowSegments)}`;

    const message = await client.messages.create({
      model: options.model,
      max_tokens: 1500,
      system: cachedSystemPrompt(SYSTEM_PROMPT),
      messages: [{ role: "user", content: userPrompt }],
      tools: [CANDIDATES_TOOL_SCHEMA],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });

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

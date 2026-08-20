import type { TranscriptSegment } from "@clipforge/shared";
import { clipCandidatesResponseSchema, type ClipCandidatesResponse } from "@clipforge/shared";
import { CANDIDATE_CHUNK_OVERLAP_SECONDS, CANDIDATE_CHUNK_WINDOW_SECONDS } from "@clipforge/shared";
import { getAnthropicClient } from "./anthropic-client.js";
import { formatSegments, segmentsInWindow } from "./transcript-formatting.js";
import { logger } from "../../lib/logger.js";

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
            start: { type: "number", description: "Timestamp di inizio in secondi dall'inizio del video." },
            end: { type: "number", description: "Timestamp di fine in secondi dall'inizio del video." },
            hook: { type: "string", description: "La frase/momento che cattura l'attenzione nei primi secondi." },
            reason: { type: "string", description: "Perché questo momento funzionerebbe come clip virale, in una frase." },
          },
          required: ["start", "end", "hook", "reason"],
        },
      },
    },
    required: ["candidates"],
  },
};

const SYSTEM_PROMPT = `Sei un analista di contenuti specializzato nell'individuare i momenti migliori di video lunghi (podcast, interviste, talk) da trasformare in YouTube Shorts verticali.

Cerca momenti con:
- hook forti nei primi secondi
- frasi sorprendenti o opinioni controverse
- storie con una struttura chiara
- punchline o momenti emotivi
- informazioni utili e concrete
- cambiamenti di tono
- un payoff comprensibile anche senza aver visto il resto del video

Evita:
- frasi che richiedono troppo contesto esterno per essere capite
- inizi lenti o finali troncati a metà frase
- momenti ripetitivi o pause morte

Ogni clip candidata deve durare idealmente tra 30 e 60 secondi (accettabile una leggera deviazione se serve a preservare il senso compiuto). Usa ESCLUSIVAMENTE i timestamp presenti nel transcript fornito: non inventare tempi. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

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
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      tools: [CANDIDATES_TOOL_SCHEMA],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });

    const parsed = extractToolInput(message);
    if (!parsed) {
      logger.warn("Nessun output strutturato dal passaggio candidati, finestra saltata", { window });
      continue;
    }

    const validation = clipCandidatesResponseSchema.safeParse(parsed);
    if (!validation.success) {
      logger.warn("Output candidati non valido secondo lo schema, finestra saltata", {
        window,
        issues: validation.error.issues,
      });
      continue;
    }

    allCandidates.push(...validation.data.candidates);
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

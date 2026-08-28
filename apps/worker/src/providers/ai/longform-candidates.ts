import { z } from "zod";
import type { TranscriptSegment } from "@clipforge/shared";
import { longformCandidateSchema, type LongformCandidatesResponse } from "@clipforge/shared";
import { LONGFORM_CHUNK_OVERLAP_SECONDS, LONGFORM_CHUNK_WINDOW_SECONDS } from "@clipforge/shared";
import { getAnthropicClient } from "./anthropic-client.js";
import { formatSegments, segmentsInWindow } from "./transcript-formatting.js";
import { logger } from "../../lib/logger.js";

// Stessa idea di due-fasi di candidates.ts: prima la struttura macroscopica, poi ogni candidato
// singolarmente, così un solo campo fuori schema non butta via l'intera finestra.
const candidatesContainerSchema = z.object({ candidates: z.array(z.unknown()).max(30) });

const TOOL_NAME = "return_longform_candidates";

const CANDIDATES_TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Restituisce i segmenti candidati (uno per argomento) individuati nel transcript di un VOD lungo.",
  input_schema: {
    type: "object" as const,
    properties: {
      candidates: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            start: { type: "number", description: "Timestamp di inizio in secondi dall'inizio del VOD." },
            end: { type: "number", description: "Timestamp di fine in secondi dall'inizio del VOD." },
            topic: { type: "string", description: "Breve descrizione dell'argomento trattato in questo segmento." },
          },
          required: ["start", "end", "topic"],
        },
      },
    },
    required: ["candidates"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto che prepara video long-form per YouTube a partire da VOD di live Twitch. Il tuo compito NON è trovare momenti brevi ad alto impatto (quello è un altro passaggio, per gli Shorts) — devi individuare SEGMENTI LUNGHI E COERENTI, ognuno dedicato a UN argomento/momento della live che regge da solo come video a sé stante (5-20 minuti), es: "un'intera partita/round di un gioco", "un'intera reazione a un video/argomento", "un'intera interazione con un ospite/i chat", "un'intera storia raccontata per esteso".

Regole:
- Ogni segmento deve avere un inizio e una fine naturali: non tagliare a metà di un discorso o di un round di gioco. Se un argomento comincia prima dell'inizio della finestra che ti è stata data o continua oltre la fine, usa comunque i timestamp REALI disponibili nel transcript fornito (non inventarli), anche se il segmento risulta parziale.
- Salta i momenti morti: setup tecnico, silenzi lunghi, chiacchiere senza argomento riconoscibile, momenti in cui la chat/il gioco caricano senza che succeda nulla.
- Non serve un "hook" come per gli Shorts: qui l'obiettivo è coerenza tematica, non un colpo di scena nei primi secondi.
- Ogni segmento deve poter reggersi da solo: chi lo guarda senza aver visto il resto della live deve poter seguire cosa succede.

Restituisci al massimo 6 segmenti per questa finestra di transcript. Usa ESCLUSIVAMENTE i timestamp presenti nel transcript fornito: non inventare tempi. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

export interface LongformCandidateDetectionOptions {
  apiKey: string;
  model: string;
  videoTitle: string;
  videoDurationSeconds: number;
}

/**
 * Passaggio economico (modello cheap): chunka il transcript in finestre di 30 minuti con
 * overlap (più larghe di quelle Shorts: i confini tra argomenti in una live si muovono su
 * scale più lunghe) e chiede segmenti per argomento in ciascuna finestra.
 */
export async function detectLongformCandidates(
  segments: TranscriptSegment[],
  options: LongformCandidateDetectionOptions,
): Promise<LongformCandidatesResponse["candidates"]> {
  const client = getAnthropicClient(options.apiKey);
  const windows = buildWindows(options.videoDurationSeconds);
  const allCandidates: LongformCandidatesResponse["candidates"] = [];

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

    const toolUse = message.content.find(
      (block): block is Extract<(typeof message.content)[number], { type: "tool_use" }> =>
        block.type === "tool_use" && block.name === TOOL_NAME,
    );
    if (!toolUse) {
      logger.warn("Nessun output strutturato dal passaggio candidati long-form, finestra saltata", { window });
      continue;
    }

    const containerValidation = candidatesContainerSchema.safeParse(toolUse.input);
    if (!containerValidation.success) {
      logger.warn("Output candidati long-form non valido secondo lo schema, finestra saltata", {
        window,
        issues: containerValidation.error.issues,
      });
      continue;
    }

    for (const rawCandidate of containerValidation.data.candidates) {
      const candidateValidation = longformCandidateSchema.safeParse(rawCandidate);
      if (!candidateValidation.success) {
        logger.warn("Candidato long-form singolo non valido, scartato", { window, issues: candidateValidation.error.issues });
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
    const end = Math.min(start + LONGFORM_CHUNK_WINDOW_SECONDS, durationSeconds);
    windows.push({ start, end });
    if (end >= durationSeconds) break;
    start += LONGFORM_CHUNK_WINDOW_SECONDS - LONGFORM_CHUNK_OVERLAP_SECONDS;
  }
  return windows;
}

/** Rimuove candidati quasi-duplicati generati da finestre sovrapposte (stesso start entro pochi secondi). */
function dedupeCandidates(
  candidates: LongformCandidatesResponse["candidates"],
): LongformCandidatesResponse["candidates"] {
  const sorted = [...candidates].sort((a, b) => a.start - b.start);
  const result: LongformCandidatesResponse["candidates"] = [];

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

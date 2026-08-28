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
  description: "Restituisce i segmenti candidati (uno per ATTIVITÀ/ARGOMENTO, non uno per momento narrativo) individuati nel transcript di un VOD lungo.",
  input_schema: {
    type: "object" as const,
    properties: {
      candidates: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            start: { type: "number", description: "Timestamp di inizio in secondi dall'inizio del VOD — l'inizio dell'ATTIVITÀ, non di un momento specifico dentro di essa." },
            end: { type: "number", description: "Timestamp di fine in secondi dall'inizio del VOD — quando l'attività finisce DAVVERO (cambio argomento/gioco), non quando finisce un episodio dentro di essa." },
            topic: { type: "string", description: "L'attività/argomento nel suo insieme, es. \"reaction ai TikTok\", \"sessione di gameplay a X\", \"discussione sullo scandalo Y\" — non un singolo evento dentro l'attività." },
          },
          required: ["start", "end", "topic"],
        },
      },
    },
    required: ["candidates"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto che prepara video long-form per YouTube a partire da VOD di live Twitch. Il tuo compito NON è trovare momenti brevi ad alto impatto (quello è un altro passaggio, per gli Shorts) — devi individuare BLOCCHI DI ATTIVITÀ INTERI, ognuno lungo quanto dura DAVVERO quell'attività (tipicamente 10-40 minuti, anche di più se l'attività continua), pensati per diventare un video YouTube completo con titolo tipo "[STREAMER] REAGISCE AI TIKTOK PIÙ ASSURDI DELLA SETTIMANA", "[STREAMER] parla dello scandalo X", "[STREAMER1], [STREAMER2] e [STREAMER3] giocano a X".

REGOLA PIÙ IMPORTANTE — confine del segmento = cambio di ATTIVITÀ, non cambio di momento: se lo streamer sta facendo reaction ai TikTok, TUTTO il blocco (dal primo "ora guardiamo un po' di TikTok" fino a quando smette e passa a fare altro) è UN SOLO segmento, anche se dura 30-40 minuti e attraversa TikTok diversi con reazioni diverse. Stesso discorso per una sessione di gioco: se il gruppo gioca a un gioco per 40 minuti, quei 40 minuti sono UN SOLO segmento anche se dentro succedono cose diverse (scoprono un obiettivo, falliscono, ci riprovano, festeggiano) — quelli sono CAPITOLI della stessa attività, NON argomenti diversi, e vanno tenuti insieme.

ERRORE DA NON RIPETERE (osservato in un run reale): un'intera sessione di "caccia e trasporto di una balena" in un gioco co-op — scoperta dell'obiettivo, caccia, un incidente (morte nel magma), recupero, trasporto, consegna finale — è stata spezzata in 4 segmenti separati da 3-5 minuti ciascuno (uno per ogni "colpo di scena"). È SBAGLIATO: è tutta la STESSA attività (quella sessione di gioco/quell'obiettivo) e andava restituita come UN SOLO segmento dall'inizio alla fine, non frammentata per ogni mini-arco narrativo al suo interno. Se ti accorgi di voler creare più segmenti ravvicinati nel tempo sullo stesso gioco/argomento senza che sia successo un vero cambio di attività in mezzo, UNISCILI in un solo segmento con start/end che coprono tutto l'arco.

Altre regole:
- Ogni segmento deve avere un inizio e una fine naturali: comincia quando l'attività comincia DAVVERO, finisce quando cambia DAVVERO argomento/gioco/attività. Se un'attività comincia prima dell'inizio della finestra che ti è stata data o continua oltre la fine, usa comunque i timestamp REALI disponibili nel transcript fornito (non inventarli), anche se il segmento risulta parziale — verrà eventualmente unito a quello della finestra successiva.
- Salta i momenti morti: setup tecnico, silenzi lunghi, chiacchiere senza argomento riconoscibile, momenti in cui la chat/il gioco caricano senza che succeda nulla — questi possono restare FUORI dal segmento (accorciano l'inizio/fine), ma non spezzano un'attività a metà solo perché per un minuto non succede nulla.
- Non serve un "hook" come per gli Shorts: qui l'obiettivo è coerenza tematica su un intero blocco, non un colpo di scena nei primi secondi.
- Preferisci pochi segmenti lunghi e coerenti a molti segmenti brevi: se questa finestra di 30 minuti di transcript è tutta la stessa attività, restituisci UN candidato che copre l'intera finestra (o quasi), non 4-5 candidati piccoli.

Restituisci al massimo 3 segmenti per questa finestra di transcript (di solito ne basta 1, a volte 2 se c'è un vero cambio di attività a metà). Usa ESCLUSIVAMENTE i timestamp presenti nel transcript fornito: non inventare tempi. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

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

import { z } from "zod";
import type { TranscriptSegment, ModelTokenUsage } from "@clipforge/shared";
import { longformCandidateSchema, type LongformCandidatesResponse } from "@clipforge/shared";
import { LONGFORM_CHUNK_OVERLAP_SECONDS, LONGFORM_CHUNK_WINDOW_SECONDS, computeModelCostUsd } from "@clipforge/shared";
import { getAnthropicClient, cachedSystemPrompt, readCacheUsage } from "./anthropic-client.js";
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
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            start: { type: "number", description: "Timestamp di inizio in secondi dall'inizio del VOD — quando QUESTO gioco/video/argomento specifico inizia davvero, non un momento dentro di esso e non l'inizio di un gioco/argomento precedente anche se simile." },
            end: { type: "number", description: "Timestamp di fine in secondi dall'inizio del VOD — quando QUESTO gioco/video/argomento specifico finisce DAVVERO (passano a un gioco/video/argomento diverso, anche dello stesso genere), non quando finisce un capitolo dentro di esso, e MAI un punto a caso se dal transcript risulta che sta ancora continuando." },
            topic: { type: "string", description: "Il gioco/video/argomento SPECIFICO, col suo nome quando esiste, es. \"Family Feud\", \"Indovina Chi\", \"reaction al video di MrBeast sugli appuntamenti\" — non una categoria generica come \"sessione di quiz\" che potrebbe coprire più giochi diversi." },
          },
          required: ["start", "end", "topic"],
        },
      },
    },
    required: ["candidates"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto che prepara video long-form per YouTube a partire da VOD di live Twitch. Il tuo compito NON è trovare momenti brevi ad alto impatto (quello è un altro passaggio, per gli Shorts) — devi individuare BLOCCHI DI ATTIVITÀ INTERI, uno per ogni gioco/video/argomento SPECIFICO, ognuno lungo esattamente quanto dura DAVVERO quella cosa specifica (mai di più, mai di meno). Un segmento sotto i 15 minuti è sospetto SOLO se è un pezzo della STESSA sessione/partita/argomento spezzata per sbaglio: prima di restituirlo, chiediti "questo è un frammento di qualcosa di più grande che sto tagliando a metà, o è un gioco/argomento che è DAVVERO durato solo così poco?" — se la seconda è vera (es. una partita veloce, un video reagito breve), il segmento corto è corretto così com'è, non allungarlo artificialmente. Target realistico quando l'attività dura tanto: 15-40 minuti, anche di più se continua — ma la durata la decide SOLO quanto dura davvero quella cosa specifica, mai un numero a cui puntare. Pensali come video YouTube completi con titolo tipo "[STREAMER] REAGISCE AI TIKTOK PIÙ ASSURDI DELLA SETTIMANA", "[STREAMER] parla dello scandalo X", "[STREAMER1], [STREAMER2] e [STREAMER3] giocano a Family Feud" — ogni titolo così copre UNA cosa specifica, mai due giochi/argomenti diversi nello stesso video anche se simili.

REGOLA PIÙ IMPORTANTE — confine del segmento = cambio di GIOCO/ARGOMENTO SPECIFICO, non cambio di momento e NON cambio di genere/formato: se lo streamer sta facendo reaction ai TikTok, TUTTO il blocco (dal primo "ora guardiamo un po' di TikTok" fino a quando smette e passa a fare altro) è UN SOLO segmento, anche se dura 30-40 minuti e attraversa TikTok diversi con reazioni diverse. Stesso discorso per una sessione di UN gioco specifico: se il gruppo gioca alla STESSA partita/sessione per 40 minuti, quei 40 minuti sono UN SOLO segmento anche se dentro succedono cose diverse (scoprono un obiettivo, falliscono, ci riprovano, festeggiano) — quelli sono CAPITOLI della stessa sessione, NON argomenti diversi, e vanno tenuti insieme.

ATTENZIONE A NON CONFONDERE "stesso genere" con "stessa attività": se il gruppo gioca a Family Feud per 30 minuti e POI, senza pausa, passa a giocare a Indovina Chi, sono DUE segmenti separati, anche se entrambi sono "giochi a quiz in squadra" con lo stesso cast — sono due giochi diversi con un nome diverso, ognuno va dal proprio inizio (quando aprono/lanciano QUEL gioco specifico) alla propria fine (quando lo chiudono o passano ad altro), anche se il cambio avviene nello stesso secondo senza soluzione di continuità. La domanda giusta da farsi al confine non è "è cambiato il tipo di contenuto?" ma "è ancora la STESSA cosa specifica (lo stesso gioco con lo stesso nome, la stessa partita, lo stesso video che stanno guardando) o ne è iniziata una diversa?" — se la risposta è "una cosa diversa, anche se simile", quello è un confine vero, anche se il segmento risultante è più corto di 15 minuti.

ERRORE DA NON RIPETERE #1 (osservato in DUE run reali): la prima volta un'intera sessione di "caccia e trasporto di una balena" in un gioco co-op è stata spezzata in 4 segmenti da 3-5 minuti (uno per ogni colpo di scena) — quella era UNA sola partita, andava tenuta insieme. La seconda volta un intero VOD è stato diviso in 14 segmenti da ~10 minuti l'uno, molti dei quali erano ancora dentro la STESSA sessione dello STESSO gioco spezzata per sbaglio in 3-4 pezzi da 10 minuti invece di un solo segmento da 30-40. Se ti accorgi di voler creare più segmenti ravvicinati nel tempo sulla STESSA sessione/partita/argomento senza che sia successo un vero cambio (nome del gioco diverso, video diverso, argomento di discussione diverso), UNISCILI in un solo segmento con start/end che coprono tutto l'arco.

ERRORE DA NON RIPETERE #2 (osservato in un run reale): un segmento di "Indovina Chi" è stato tagliato a 260 minuti quando in realtà il gioco (stessa partita, stesse domande, stessi partecipanti) continuava ancora IDENTICO fino a oltre 275 minuti — l'AI ha semplicemente smesso di seguirlo, non c'era stato nessun cambio di gioco/argomento reale a quel punto. Prima di fissare un "end", verifica sul transcript che l'attività sia DAVVERO finita (è iniziato un gioco/video/discussione diverso) e non ti sei solo fermato a metà per pigrizia o perché la finestra stava per esaurirsi — se la finestra finisce mentre l'attività è ancora in corso, usa come "end" l'ultimo timestamp disponibile nella finestra, MAI un punto a caso prima che l'attività finisca davvero.

Altre regole:
- Ogni segmento deve avere un inizio e una fine naturali: comincia quando l'attività comincia DAVVERO, finisce quando cambia DAVVERO argomento/gioco/attività/formato. Se un'attività comincia prima dell'inizio della finestra che ti è stata data o continua oltre la fine, usa comunque i timestamp REALI disponibili nel transcript fornito (non inventarli), anche se il segmento risulta parziale — verrà eventualmente unito a quello della finestra successiva.
- Salta i momenti morti: setup tecnico, silenzi lunghi, chiacchiere senza argomento riconoscibile, momenti in cui la chat/il gioco caricano senza che succeda nulla — questi possono restare FUORI dal segmento (accorciano l'inizio/fine), ma non spezzano un'attività a metà solo perché per un minuto non succede nulla.
- Non serve un "hook" come per gli Shorts: qui l'obiettivo è coerenza tematica su un intero blocco, non un colpo di scena nei primi secondi.
- Non spezzare la STESSA sessione/partita/argomento in più candidati ravvicinati: se questa finestra di 45 minuti è tutta lo stesso gioco/video/discussione, restituisci UN candidato che copre l'intera finestra (o quasi), non 2-3 pezzi. Ma se dentro la finestra c'è un vero cambio (gioco diverso, video diverso, argomento diverso), restituisci candidati SEPARATI anche se entrambi corti — non fonderli solo perché sono vicini nel tempo o si assomigliano nel genere.

Restituisci al massimo 2 segmenti per questa finestra di transcript (quasi sempre ne basta 1 — un secondo solo se c'è un VERO cambio di attività a metà finestra). Usa ESCLUSIVAMENTE i timestamp presenti nel transcript fornito: non inventare tempi. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

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
export interface LongformCandidateDetectionResult {
  candidates: LongformCandidatesResponse["candidates"];
  usage: ModelTokenUsage;
}

export async function detectLongformCandidates(
  segments: TranscriptSegment[],
  options: LongformCandidateDetectionOptions,
): Promise<LongformCandidateDetectionResult> {
  const client = getAnthropicClient(options.apiKey);
  const windows = buildWindows(options.videoDurationSeconds);
  const allCandidates: LongformCandidatesResponse["candidates"] = [];

  // Uso REALE misurato (non stimato) di questo passaggio, per confrontare previsione vs consumo
  // vero — vedi il log finale sotto.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let apiCalls = 0;

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

    apiCalls++;
    totalInputTokens += message.usage.input_tokens;
    totalOutputTokens += message.usage.output_tokens;
    const cacheUsage = readCacheUsage(message.usage);
    totalCacheReadTokens += cacheUsage.cacheRead;
    totalCacheWriteTokens += cacheUsage.cacheWrite;

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

  const usage: ModelTokenUsage = {
    input: totalInputTokens,
    output: totalOutputTokens,
    cacheRead: totalCacheReadTokens,
    cacheWrite: totalCacheWriteTokens,
    calls: apiCalls,
  };
  logger.info("Costo REALE misurato — passaggio candidati long-form (Haiku)", {
    ...usage,
    costUsd: computeModelCostUsd("haiku", usage).toFixed(4),
  });

  return {
    candidates: mergeNearbyCandidates(dedupeCandidates(allCandidates)),
    usage,
  };
}

// Se due candidati (anche da finestre diverse) sono separati da un vuoto breve E parlano dello
// STESSO argomento, quasi sempre è la STESSA attività spezzata per sbaglio (osservato in
// pratica: un'intera sessione di gioco divisa in pezzi da ~10 minuti) — non ci affidiamo solo al
// prompt per evitarlo, lo forziamo qui. La vicinanza nel tempo da sola NON basta: osservato in
// pratica che fondeva anche argomenti diversi solo perché ravvicinati (es. reaction calcio +
// Family Feud + altre reaction finiti in un unico blocco da 7 ore), quindi ora richiede ANCHE
// una somiglianza reale tra i topic (vedi topicsAreSimilar) prima di unire.
const MERGE_GAP_SECONDS = 300; // 5 minuti

// Parole troppo comuni in italiano per essere un segnale di somiglianza tra topic — altrimenti
// due topic completamente diversi che condividono solo "e", "di", "con" sembrerebbero simili.
const STOPWORDS = new Set([
  "e",
  "a",
  "di",
  "da",
  "in",
  "con",
  "su",
  "per",
  "tra",
  "fra",
  "il",
  "lo",
  "la",
  "i",
  "gli",
  "le",
  "un",
  "una",
  "uno",
  "al",
  "alla",
  "del",
  "della",
  "dei",
  "sul",
  "sulla",
  "che",
  "si",
]);

function significantWords(topic: string): Set<string> {
  return new Set(
    topic
      .toLowerCase()
      .split(/[^a-zà-ù0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/**
 * Somiglianza grezza tra due topic (Jaccard sulle parole significative): non serve capire il
 * significato, solo distinguere "stessa cosa specifica riformulata diversamente" da "cosa
 * diversa ma dello stesso genere" (es. Family Feud vs Indovina Chi: entrambi "quiz a squadre",
 * ma due giochi diversi che l'utente vuole SEPARATI, non fusi). Soglia alta apposta (0.4): il
 * prompt ora è responsabile di non fondere/spezzare per primo, questo è solo un secondo
 * controllo per lo stesso identico gioco/argomento tagliato da un confine di finestra — non deve
 * fondere due cose solo perché condividono vocabolario generico di genere ("quiz", "squadre").
 */
function topicsAreSimilar(topicA: string, topicB: string): boolean {
  const wordsA = significantWords(topicA);
  const wordsB = significantWords(topicB);
  if (wordsA.size === 0 || wordsB.size === 0) return false;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return intersection / union >= 0.4;
}

/**
 * Unisce candidati consecutivi (ordinati per start) separati da meno di MERGE_GAP_SECONDS SOLO
 * se il topic è riconoscibilmente lo stesso — vedi topicsAreSimilar.
 */
function mergeNearbyCandidates(
  candidates: LongformCandidatesResponse["candidates"],
): LongformCandidatesResponse["candidates"] {
  const sorted = [...candidates].sort((a, b) => a.start - b.start);
  const result: LongformCandidatesResponse["candidates"] = [];

  for (const candidate of sorted) {
    const last = result[result.length - 1];
    if (last && candidate.start - last.end < MERGE_GAP_SECONDS && topicsAreSimilar(last.topic, candidate.topic)) {
      // Tiene il topic del segmento più lungo tra i due (confronto PRIMA di estendere last.end):
      // dopo la fusione il passaggio di ranking guarda comunque il transcript completo del nuovo
      // intervallo per scrivere titolo/descrizione reali, questo campo è solo un indizio.
      if (candidate.end - candidate.start > last.end - last.start) {
        last.topic = candidate.topic;
      }
      last.end = Math.max(last.end, candidate.end);
    } else {
      result.push({ ...candidate });
    }
  }

  return result;
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

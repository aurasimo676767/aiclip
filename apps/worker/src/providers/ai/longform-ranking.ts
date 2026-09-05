import type { TranscriptSegment, LongformCandidateWindow, RankedLongformClip, ModelTokenUsage } from "@clipforge/shared";
import {
  rankedLongformClipsResponseSchema,
  CLIP_BADGES,
  buildLongformTitleStylePrompt,
  computeModelCostUsd,
  classifyModelTier,
} from "@clipforge/shared";
import { getAnthropicClient, cachedSystemPrompt, readCacheUsage } from "./anthropic-client.js";
import { formatSegments, segmentsInWindow } from "./transcript-formatting.js";
import { logger } from "../../lib/logger.js";
import type Anthropic from "@anthropic-ai/sdk";

const TOOL_NAME = "return_ranked_longform_clips";

const RANKING_TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Restituisce i segmenti long-form finali selezionati, con punteggi e metadati di pubblicazione.",
  input_schema: {
    type: "object" as const,
    properties: {
      clips: {
        type: "array",
        maxItems: 15,
        items: {
          type: "object",
          properties: {
            start: {
              type: "number",
              description:
                "Deve coincidere con l'inizio dell'intervallo ASSEGNATO al candidato (vedi il messaggio utente), salvo rifinire di pochi secondi/decina di secondi un residuo di setup — MAI spostarlo in avanti per 'iniziare dal pezzo migliore' scartando la prima parte del candidato.",
            },
            end: {
              type: "number",
              description:
                "Deve coincidere con la fine dell'intervallo ASSEGNATO al candidato, salvo rifinire di pochi secondi/decina di secondi una coda morta — MAI accorciarlo per tenere solo 'il momento migliore': un candidato lungo con più giochi/eventi va tenuto per intero, non ridotto a un sottoinsieme.",
            },
            duration: { type: "number", description: "end - start, quindi quasi identica alla durata originale del candidato assegnato." },
            title: {
              type: "string",
              description:
                "Titolo REALE di pubblicazione YouTube per un video long-form (NON lo stile Shorts urlato/maiuscolo) — descrittivo ma comunque accattivante, es. \"[NOME] reagisce a [X] per la prima volta\", \"Il momento in cui [NOME] scopre che...\". Max ~100 caratteri.",
            },
            hook: { type: "string", description: "Riassunto in una frase di cosa succede nel segmento (uso interno dashboard)." },
            reason: { type: "string", description: "Perché questo segmento regge da solo come video, in 1-2 frasi (interno)." },
            scores: {
              type: "object",
              properties: {
                hook: { type: "integer", minimum: 0, maximum: 100 },
                retention: { type: "integer", minimum: 0, maximum: 100 },
                emotion: { type: "integer", minimum: 0, maximum: 100 },
                clarity: { type: "integer", minimum: 0, maximum: 100 },
                payoff: { type: "integer", minimum: 0, maximum: 100 },
                virality: { type: "integer", minimum: 0, maximum: 100 },
              },
              required: ["hook", "retention", "emotion", "clarity", "payoff", "virality"],
            },
            hashtags: {
              type: "array",
              maxItems: 10,
              items: { type: "string" },
              description: "5-8 hashtag pertinenti, SENZA il simbolo #, in minuscolo, senza spazi.",
            },
            caption: {
              type: "string",
              description:
                "Descrizione pubblica del video (non solo una didascalia breve come per gli Shorts): 2-4 frasi che spiegano di cosa parla il segmento, in italiano naturale, pronta per la pubblicazione.",
            },
            badges: {
              type: "array",
              maxItems: 5,
              items: { type: "string", enum: [...CLIP_BADGES] },
              description: "Pattern virali riconosciuti (stessi delle Shorts), opzionale — array vuoto se nessuno calza.",
            },
          },
          required: ["start", "end", "duration", "title", "hook", "reason", "scores", "hashtags", "caption", "badges"],
        },
      },
    },
    required: ["clips"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto che seleziona i segmenti finali di un video long-form da pubblicare su YouTube, a partire da un VOD di live Twitch già diviso in candidati per argomento dal primo passaggio. Ricevi i candidati con il transcript di contesto. Per ognuno:

REGOLA PIÙ IMPORTANTE SU start/end — ERRORE OSSERVATO IN PRODUZIONE DA NON RIPETERE: questo NON è il passaggio Shorts, non stai scegliendo il momento migliore DENTRO un candidato. Un candidato di 45 minuti con 4 giochi diversi (es. Rocket League + Trackmania + Super Animal Royale + Battaglia Navale) va tenuto TUTTO INTERO se la sessione regge — NON va spezzettato in 3-4 clip più corte da 6-15 minuti ciascuna scegliendo "i pezzi migliori". Osservato esattamente questo errore: un candidato da 45 minuti è uscito come 4 mini-clip separate che coprivano solo una frazione del blocco originale, perdendo la maggior parte del contenuto. start ed end del tuo output devono coincidere con l'intervallo ASSEGNATO al candidato (vedi sotto), con AL MASSIMO qualche decina di secondi di rifinitura ai due estremi (togliere un residuo di setup o di coda morta) — mai un taglio che elimina una parte sostanziale del candidato per "tenere solo il meglio".

1. Scarta (intero candidato, non accorciarlo) quelli deboli: argomento troppo vago, segmento che non regge da solo, oppure — questo è un motivo di SCARTO COMPLETO, non di accorciamento — la maggior parte del candidato è morta/ripetitiva rispetto al poco contenuto reale (es. un candidato di 15 minuti che è per il 90% silenzio o chiacchiere a vuoto attorno a 3 minuti di contenuto: qui il candidato va scartato del tutto, MAI ridotto a quei 3 minuti tagliando il resto). Meglio scartare un candidato intero che restituirne una versione tagliata a pezzi.
2. Assegna 6 punteggi da 0 a 100 (hook, retention, emotion, clarity, payoff, virality), calibrati sull'INTERA scala — usa lo stesso criterio di calibrazione di un editor Shorts esperto: 90-100 eccezionale/riservato al vero top, 75-89 forte, 55-74 discreto, sotto 55 debole (scarta invece di includere con punteggi bassi).
3. Scrivi title, hook, reason (vedi "Stile titoli" sotto per title — hook/reason restano interni, solo per la dashboard).
4. Genera 5-8 hashtag pertinenti (senza #, minuscolo, senza spazi).
5. Scrivi una caption/descrizione pubblica più lunga di quella di uno Short (2-4 frasi), che spieghi di cosa parla il segmento — qui va bene essere più descrittivi ed esaustivi, a differenza del teaser breve degli Shorts.
6. Assegna (opzionalmente) badge tra: "gotcha", "cliffhanger", "controversial", "relatable", "high_energy" — stessi criteri degli Shorts, array vuoto se nessuno calza davvero.

${buildLongformTitleStylePrompt()}

Usa ESCLUSIVAMENTE i timestamp presenti nel transcript fornito. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

export interface LongformRankingOptions {
  apiKey: string;
  model: string;
  videoTitle: string;
  streamerName: string | null;
}

export interface LongformRankingResult {
  clips: RankedLongformClip[];
  usage: ModelTokenUsage;
}

export async function rankLongformClips(
  candidates: LongformCandidateWindow[],
  segments: TranscriptSegment[],
  options: LongformRankingOptions,
): Promise<LongformRankingResult> {
  if (candidates.length === 0) return { clips: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 } };

  const client = getAnthropicClient(options.apiKey);
  const userContent = buildUserContent(candidates, segments, options.videoTitle, options.streamerName);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userContent }];

  // Uso REALE misurato di questo passaggio (il più caro) — vedi logRankingCost sotto, chiamato
  // sia sul successo sia sul fallimento finale, così un tentativo fallito si vede comunque nel
  // costo (viene fatturato lo stesso).
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let apiCalls = 0;

  function buildUsage(): ModelTokenUsage {
    return {
      input: totalInputTokens,
      output: totalOutputTokens,
      cacheRead: totalCacheReadTokens,
      cacheWrite: totalCacheWriteTokens,
      calls: apiCalls,
    };
  }

  function logRankingCost() {
    const usage = buildUsage();
    // Fallback "sonnet" solo per non far esplodere il log se options.model è un ID non
    // riconosciuto (vedi classifyModelTier) — il costo persistito in usage_stats (calcolato in
    // process-video-job.ts) fa lo stesso fallback e logga un warning dedicato in quel caso.
    const tier = classifyModelTier(options.model) ?? "sonnet";
    logger.info("Costo REALE misurato — passaggio ranking long-form", {
      model: options.model,
      ...usage,
      costUsd: computeModelCostUsd(tier, usage).toFixed(4),
    });
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const message = await client.messages.create({
      model: options.model,
      max_tokens: 8000,
      system: cachedSystemPrompt(SYSTEM_PROMPT),
      messages,
      tools: [RANKING_TOOL_SCHEMA],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });

    apiCalls++;
    totalInputTokens += message.usage.input_tokens;
    totalOutputTokens += message.usage.output_tokens;
    const cacheUsage = readCacheUsage(message.usage);
    totalCacheReadTokens += cacheUsage.cacheRead;
    totalCacheWriteTokens += cacheUsage.cacheWrite;

    const toolUseBlock = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME,
    );

    if (!toolUseBlock) {
      logger.warn("Nessun output strutturato dal passaggio di ranking long-form", { attempt });
      continue;
    }

    const validation = rankedLongformClipsResponseSchema.safeParse(toolUseBlock.input);
    if (validation.success) {
      logRankingCost();
      return { clips: validation.data.clips as RankedLongformClip[], usage: buildUsage() };
    }

    logger.warn("Output di ranking long-form non valido, tentativo di correzione", { attempt, issues: validation.error.issues });

    messages.push({ role: "assistant", content: message.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          is_error: true,
          content: `Il tuo output precedente non rispetta lo schema richiesto. Errori: ${validation.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}. Richiama lo strumento ${TOOL_NAME} con un input corretto.`,
        },
      ],
    });
  }

  logRankingCost();
  throw new Error("Il passaggio di ranking AI long-form non ha prodotto un output valido dopo 2 tentativi");
}

function buildUserContent(
  candidates: LongformCandidateWindow[],
  segments: TranscriptSegment[],
  videoTitle: string,
  streamerName: string | null,
): Anthropic.TextBlockParam[] {
  const CONTEXT_PADDING_SECONDS = 30;

  const content: Anthropic.TextBlockParam[] = [
    { type: "text", text: `Video: "${videoTitle}"${streamerName ? ` — streamer: ${streamerName}` : ""}` },
  ];

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    const contextSegments = segmentsInWindow(
      segments,
      Math.max(0, candidate.start - CONTEXT_PADDING_SECONDS),
      candidate.end + CONTEXT_PADDING_SECONDS,
    );

    content.push({
      type: "text",
      text: `### Candidato ${index + 1}
Argomento individuato (dal primo passaggio): ${candidate.topic}
Intervallo ASSEGNATO a questo candidato: ${candidate.start.toFixed(0)}s - ${candidate.end.toFixed(0)}s (${((candidate.end - candidate.start) / 60).toFixed(1)} minuti) — vedi le regole sopra su start/end: NON è un intervallo da cui estrarre un momento più corto, è il blocco che devi valutare/scartare così com'è.
Transcript con contesto (include ${CONTEXT_PADDING_SECONDS}s in più su ciascun lato SOLO per capire se il confine va rifinito di pochi secondi, non per scegliere un sotto-segmento): ${(candidate.start - CONTEXT_PADDING_SECONDS).toFixed(0)}s - ${(candidate.end + CONTEXT_PADDING_SECONDS).toFixed(0)}s:
${formatSegments(contextSegments)}`,
    });
  }

  return content;
}

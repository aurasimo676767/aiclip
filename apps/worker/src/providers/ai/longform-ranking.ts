import type { TranscriptSegment, LongformCandidateWindow, RankedLongformClip } from "@clipforge/shared";
import { rankedLongformClipsResponseSchema, CLIP_BADGES } from "@clipforge/shared";
import { getAnthropicClient } from "./anthropic-client.js";
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
            start: { type: "number" },
            end: { type: "number" },
            duration: { type: "number" },
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

1. Scarta i candidati deboli: argomento troppo vago, segmento che non regge da solo, durata sproporzionata rispetto al contenuto reale (es. 15 minuti per un argomento esaurito in 3). Meglio pochi segmenti forti che tanti mediocri.
2. Assegna 6 punteggi da 0 a 100 (hook, retention, emotion, clarity, payoff, virality), calibrati sull'INTERA scala — usa lo stesso criterio di calibrazione di un editor Shorts esperto: 90-100 eccezionale/riservato al vero top, 75-89 forte, 55-74 discreto, sotto 55 debole (scarta invece di includere con punteggi bassi).
3. Scrivi title, hook, reason (vedi "Stile titoli" sotto per title — hook/reason restano interni, solo per la dashboard).
4. Genera 5-8 hashtag pertinenti (senza #, minuscolo, senza spazi).
5. Scrivi una caption/descrizione pubblica più lunga di quella di uno Short (2-4 frasi), che spieghi di cosa parla il segmento — qui va bene essere più descrittivi ed esaustivi, a differenza del teaser breve degli Shorts.
6. Assegna (opzionalmente) badge tra: "gotcha", "cliffhanger", "controversial", "relatable", "high_energy" — stessi criteri degli Shorts, array vuoto se nessuno calza davvero.

Stile titoli (campo "title" — è il titolo REALE con cui il video viene pubblicato): per il long-form NON si usa lo stile "urlato" da Short (niente MAIUSCOLO diffuso, niente punteggiatura doppia tipo "?!"/"!!"). Scrivi titoli descrittivi ma comunque accattivanti, come i video long-form di reaction/streaming italiani di successo: indica chi è coinvolto e cosa succede, es. "[Nome] reagisce a [argomento] per la prima volta", "Il momento in cui [Nome] scopre [cosa]", "[Nome] prova [attività] in diretta — reazione completa". Massimo ~100 caratteri, prima lettera maiuscola normale (non tutto maiuscolo).

Usa ESCLUSIVAMENTE i timestamp presenti nel transcript fornito. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

export interface LongformRankingOptions {
  apiKey: string;
  model: string;
  videoTitle: string;
  streamerName: string | null;
}

export async function rankLongformClips(
  candidates: LongformCandidateWindow[],
  segments: TranscriptSegment[],
  options: LongformRankingOptions,
): Promise<RankedLongformClip[]> {
  if (candidates.length === 0) return [];

  const client = getAnthropicClient(options.apiKey);
  const userContent = buildUserContent(candidates, segments, options.videoTitle, options.streamerName);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userContent }];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const message = await client.messages.create({
      model: options.model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages,
      tools: [RANKING_TOOL_SCHEMA],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });

    const toolUseBlock = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME,
    );

    if (!toolUseBlock) {
      logger.warn("Nessun output strutturato dal passaggio di ranking long-form", { attempt });
      continue;
    }

    const validation = rankedLongformClipsResponseSchema.safeParse(toolUseBlock.input);
    if (validation.success) {
      return validation.data.clips as RankedLongformClip[];
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
Transcript con contesto (${(candidate.start - CONTEXT_PADDING_SECONDS).toFixed(0)}s - ${(candidate.end + CONTEXT_PADDING_SECONDS).toFixed(0)}s):
${formatSegments(contextSegments)}`,
    });
  }

  return content;
}

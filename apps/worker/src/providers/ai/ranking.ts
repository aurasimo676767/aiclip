import type { TranscriptSegment, ClipCandidateWindow, RankedClip } from "@clipforge/shared";
import { rankedClipsResponseSchema, TEMPLATE_NAMES, EDITING_STYLES } from "@clipforge/shared";
import { getAnthropicClient } from "./anthropic-client.js";
import { formatSegments, segmentsInWindow } from "./transcript-formatting.js";
import { logger } from "../../lib/logger.js";
import type Anthropic from "@anthropic-ai/sdk";

const TOOL_NAME = "return_ranked_clips";

const EDL_EVENT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        time: { type: "number" },
        action: { type: "string", enum: ["zoom"] },
        scale: { type: "number", description: "1.0-2.0, es. 1.1 per un leggero zoom-in" },
      },
      required: ["time", "action", "scale"],
    },
    {
      type: "object",
      properties: {
        time: { type: "number" },
        action: { type: "string", enum: ["punch_in"] },
        scale: { type: "number" },
      },
      required: ["time", "action", "scale"],
    },
    {
      type: "object",
      properties: {
        time: { type: "number" },
        action: { type: "string", enum: ["highlight_word"] },
        word: { type: "string" },
      },
      required: ["time", "action", "word"],
    },
    {
      type: "object",
      properties: {
        time: { type: "number" },
        action: { type: "string", enum: ["speaker_switch"] },
        speaker: { type: "string" },
      },
      required: ["time", "action", "speaker"],
    },
  ],
};

const RANKING_TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Restituisce le clip finali selezionate, con punteggi ed Edit Decision List (EDL).",
  input_schema: {
    type: "object" as const,
    properties: {
      clips: {
        type: "array",
        maxItems: 30,
        items: {
          type: "object",
          properties: {
            start: { type: "number" },
            end: { type: "number" },
            duration: { type: "number" },
            hook: { type: "string" },
            title: { type: "string", description: "Titolo breve e accattivante per lo Short, max ~80 caratteri." },
            reason: { type: "string", description: "Perché questa clip funziona, in 1-2 frasi." },
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
            editing_style: { type: "string", enum: [...EDITING_STYLES] },
            edl: {
              type: "object",
              properties: {
                template: { type: "string", enum: [...TEMPLATE_NAMES] },
                events: { type: "array", maxItems: 40, items: EDL_EVENT_SCHEMA },
              },
              required: ["template", "events"],
            },
          },
          required: ["start", "end", "duration", "hook", "title", "reason", "scores", "editing_style", "edl"],
        },
      },
    },
    required: ["clips"],
  },
};

const SYSTEM_PROMPT = `Sei un editor esperto di YouTube Shorts, ESIGENTE: il primo passaggio (economico) ha già scremato molto, ma tende comunque a lasciar passare momenti "energici ma vuoti" — rumorosi o pieni di parolacce senza un vero payoff comico/narrativo dietro. Il tuo lavoro è il controllo qualità finale. Ricevi una lista di finestre candidate con il transcript di contesto, e devi:

1. Scartare senza pietà i candidati deboli: poco hook, poco comprensibili da soli, ripetitivi, o semplicemente "rumorosi" (esclamazioni/parolacce) senza una battuta, una svolta o un fatto concreto dietro. Meglio restituire 2 clip forti che 6 mediocri — non riempire la lista per riempirla.
2. Per ognuno dei rimanenti, assegnare 6 punteggi da 0 a 100 (hook, retention, emotion, clarity, payoff, virality) usando l'INTERA scala in modo calibrato, non ammassata in una fascia stretta:
   - 90-100: eccezionale, tra i migliori momenti possibili per quel tipo di contenuto — riservalo a ciò che è realmente il top, non usarlo come default per "molto buono".
   - 75-89: forte, chiaramente sopra la media, funzionerebbe bene come Short.
   - 55-74: discreto, ha potenziale ma non è memorabile.
   - Sotto 55: debole — se un candidato scende sistematicamente sotto 50 su più dimensioni, scartalo invece di includerlo con punteggi bassi.
   Differenzia davvero il candidato migliore dagli altri: se 5 clip diverse meritano tutte "80" su ogni dimensione, non stai valutando abbastanza a fondo — quasi sempre alcune si distinguono nettamente dalle altre.
3. Scrivere un titolo breve accattivante e il motivo (reason) per cui la clip funziona.
4. Scegliere un editing_style (dynamic, clean, high_energy, calm) e un template coerente tra PODCAST_DYNAMIC, PODCAST_CLEAN, STREAMER, STORYTELLING, MOTIVATIONAL.
5. Generare una Edit Decision List (EDL) con eventi "zoom" (sui momenti di enfasi), "highlight_word" (sulle 2-5 parole chiave più importanti della clip), "speaker_switch" (se cambia chi parla) e opzionalmente "punch_in" su un climax. I timestamp degli eventi devono cadere DENTRO l'intervallo [start, end] della clip e sono relativi al video originale (stessa timeline del transcript), non relativi all'inizio della clip.

Usa ESCLUSIVAMENTE i timestamp presenti nel transcript fornito. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

export interface RankingOptions {
  apiKey: string;
  model: string;
  videoTitle: string;
}

export async function rankAndBuildEdl(
  candidates: ClipCandidateWindow[],
  segments: TranscriptSegment[],
  options: RankingOptions,
): Promise<RankedClip[]> {
  if (candidates.length === 0) return [];

  const client = getAnthropicClient(options.apiKey);
  const userPrompt = buildUserPrompt(candidates, segments, options.videoTitle);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];

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
      logger.warn("Nessun output strutturato dal passaggio di ranking", { attempt });
      continue;
    }

    const validation = rankedClipsResponseSchema.safeParse(toolUseBlock.input);
    if (validation.success) {
      return validation.data.clips as RankedClip[];
    }

    logger.warn("Output di ranking non valido, tentativo di correzione", { attempt, issues: validation.error.issues });

    // Un messaggio assistant con un blocco tool_use DEVE essere seguito da un tool_result
    // (con lo stesso tool_use_id) nel messaggio successivo, non da testo libero — altrimenti
    // l'API Anthropic rifiuta la richiesta successiva con un 400.
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

  throw new Error("Il passaggio di ranking AI non ha prodotto un output valido dopo 2 tentativi");
}

function buildUserPrompt(candidates: ClipCandidateWindow[], segments: TranscriptSegment[], videoTitle: string): string {
  const CONTEXT_PADDING_SECONDS = 20;

  const candidateBlocks = candidates.map((candidate, index) => {
    const contextSegments = segmentsInWindow(
      segments,
      Math.max(0, candidate.start - CONTEXT_PADDING_SECONDS),
      candidate.end + CONTEXT_PADDING_SECONDS,
    );
    return `### Candidato ${index + 1}
Hook individuato: ${candidate.hook}
Motivo (dal primo passaggio): ${candidate.reason}
Transcript con contesto (${(candidate.start - CONTEXT_PADDING_SECONDS).toFixed(0)}s - ${(candidate.end + CONTEXT_PADDING_SECONDS).toFixed(0)}s):
${formatSegments(contextSegments)}`;
  });

  return `Video: "${videoTitle}"

${candidateBlocks.join("\n\n")}`;
}

import type { TranscriptSegment, RankedLongformClip, ModelTokenUsage, ClipScores } from "@clipforge/shared";
import { CLIP_BADGES, buildLongformTitleStylePrompt, computeModelCostUsd, classifyModelTier } from "@clipforge/shared";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, cachedSystemPrompt, readCacheUsage, toolChoiceFor } from "./anthropic-client.js";
import { fmt, type PlannedVideo, type TimelineBlock } from "./longform-plan.js";
import { logger } from "../../lib/logger.js";

/**
 * Titolo, descrizione, hashtag e punteggi dei video long-form GIÀ decisi dalla mappa del VOD e dalla
 * rifinitura dei confini. Prende il posto del vecchio ranking (longform-ranking.ts), che rimandava
 * al modello l'intero transcript di ogni candidato e poteva scartarli o accorciarli: qui inizio e
 * fine non si toccano e ogni video resta. Al modello basta sapere cosa contiene ogni video (i
 * blocchi della mappa) più qualche estratto del parlato: pochi token invece del VOD intero.
 */

const TOOL_NAME = "return_video_metadata";

const scoreProperty = { type: "integer", minimum: 0, maximum: 100 };

const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Restituisce titolo, descrizione e punteggi di ogni video, identificato dal suo numero.",
  input_schema: {
    type: "object" as const,
    properties: {
      videos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "Il numero del video, copiato dalla richiesta." },
            title: {
              type: "string",
              description: "Titolo YouTube long-form (non stile Shorts urlato), descrittivo ma accattivante. Max ~100 caratteri.",
            },
            hook: { type: "string", description: "Cosa succede nel video, in una frase (uso interno)." },
            reason: { type: "string", description: "Perché regge come video, in 1-2 frasi (uso interno)." },
            scores: {
              type: "object",
              properties: {
                hook: scoreProperty,
                retention: scoreProperty,
                emotion: scoreProperty,
                clarity: scoreProperty,
                payoff: scoreProperty,
                virality: scoreProperty,
              },
              required: ["hook", "retention", "emotion", "clarity", "payoff", "virality"],
            },
            hashtags: { type: "array", maxItems: 10, items: { type: "string" }, description: "5-8 hashtag senza #, minuscoli, senza spazi." },
            caption: { type: "string", description: "Descrizione pubblica: 2-4 frasi su cosa succede nel video." },
            badges: { type: "array", maxItems: 5, items: { type: "string", enum: [...CLIP_BADGES] } },
          },
          required: ["index", "title", "hook", "reason", "scores", "hashtags", "caption", "badges"],
        },
      },
    },
    required: ["videos"],
  },
};

const SYSTEM_PROMPT = `Prepari la pubblicazione su YouTube di video long-form ricavati da una live Twitch italiana. I video sono già tagliati: per ognuno ricevi l'attività, cosa succede dentro (la mappa della live, blocco per blocco) e alcuni estratti del parlato. Non scartarne nessuno e non cambiare i tempi.

Per ogni video scrivi:
- title: il titolo reale di pubblicazione. Deve dire l'attività e il momento più forte che succede dentro. Per i video divisi in parti metti "(Parte N)" in fondo al titolo.
- hook e reason: interni, per la dashboard.
- scores: 6 punteggi 0-100 (hook, retention, emotion, clarity, payoff, virality) calibrati su tutta la scala: 90-100 eccezionale, 75-89 forte, 55-74 discreto, sotto 55 debole. Servono a ordinare i video, quindi differenziali davvero fra loro.
- hashtags: 5-8, senza #, minuscoli, senza spazi.
- caption: 2-4 frasi in italiano naturale su cosa succede nel video.
- badges: fra "gotcha", "cliffhanger", "controversial", "relatable", "high_energy"; lista vuota se nessuno calza davvero.

${buildLongformTitleStylePrompt()}

Rispondi per TUTTI i video chiamando lo strumento ${TOOL_NAME}.`;

// Sonnet 5 a volte restituisce liste e oggetti annidati come TESTO JSON (visto sulla mappa del VOD):
// si leggono comunque invece di scartare il video.
function parseJsonText(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

const score = z.coerce.number().transform((n) => Math.max(0, Math.min(100, Math.round(n))));

const itemSchema = z.object({
  index: z.coerce.number().int(),
  title: z.string().min(1).transform((s) => s.slice(0, 100)),
  hook: z.string().default("").transform((s) => s.slice(0, 200)),
  reason: z.string().default("").transform((s) => s.slice(0, 400)),
  scores: z.preprocess(
    parseJsonText,
    z.object({ hook: score, retention: score, emotion: score, clarity: score, payoff: score, virality: score }),
  ),
  hashtags: z
    .preprocess(parseJsonText, z.array(z.string()))
    .default([])
    .transform((tags) => tags.map((t) => t.replace(/^#/, "").replace(/\s+/g, "").toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 10)),
  caption: z.string().default("").transform((s) => s.slice(0, 1000)),
  badges: z
    .preprocess(parseJsonText, z.array(z.string()))
    .default([])
    .transform((b) => b.filter((x): x is (typeof CLIP_BADGES)[number] => (CLIP_BADGES as readonly string[]).includes(x)).slice(0, 5)),
});

const responseSchema = z.object({ videos: z.preprocess(parseJsonText, z.array(z.unknown())) });

/** Righe del parlato mandate per video: le prime, le ultime e alcune in mezzo, prese a intervalli regolari. */
const OPENING_LINES = 8;
const CLOSING_LINES = 4;
const MIDDLE_LINES = 14;
const LINE_MAX_CHARS = 220;

export interface LongformMetadataOptions {
  apiKey: string;
  model: string;
  videoTitle: string;
  streamerName: string | null;
}

export async function describePlannedVideos(
  videos: PlannedVideo[],
  timeline: TimelineBlock[],
  segments: TranscriptSegment[],
  options: LongformMetadataOptions,
): Promise<{ clips: RankedLongformClip[]; usage: ModelTokenUsage }> {
  const usage: ModelTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  if (videos.length === 0) return { clips: [], usage };

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const userPrompt = [
    `Live: "${options.videoTitle}"${options.streamerName ? ` — streamer: ${options.streamerName}` : ""}`,
    ...videos.map((v, i) => describeForPrompt(i, v, timeline, sorted)),
  ].join("\n\n");

  const client = getAnthropicClient(options.apiKey);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  const byIndex = new Map<number, z.infer<typeof itemSchema>>();

  for (let attempt = 1; attempt <= 2 && byIndex.size < videos.length; attempt++) {
    const message = await client.messages.create({
      model: options.model,
      max_tokens: 8000,
      system: cachedSystemPrompt(SYSTEM_PROMPT),
      messages,
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
    // Si tiene ogni video valido anche se altri non lo sono: al secondo giro si chiedono solo i mancanti.
    if (toolUse && !parsed?.success) logger.warn("Metadati long-form: risposta illeggibile", { input: JSON.stringify(toolUse.input).slice(0, 600) });
    for (const raw of parsed?.success ? parsed.data.videos : []) {
      const item = itemSchema.safeParse(parseJsonText(raw));
      if (item.success && item.data.index >= 0 && item.data.index < videos.length) byIndex.set(item.data.index, item.data);
      else if (!item.success) logger.warn("Metadati long-form: video scartato", { issues: item.error.issues.slice(0, 3), raw: JSON.stringify(raw).slice(0, 400) });
    }
    if (byIndex.size === videos.length || !toolUse) continue;

    const missing = videos.map((_, i) => i).filter((i) => !byIndex.has(i));
    logger.warn("Metadati long-form incompleti, si richiedono i mancanti", { attempt, missing });
    messages.push({ role: "assistant", content: message.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: `Mancano o non rispettano lo schema i video ${missing.join(", ")}. Richiama ${TOOL_NAME} solo per questi.`,
        },
      ],
    });
  }

  const tier = classifyModelTier(options.model) ?? "sonnet";
  logger.info("Costo REALE misurato — metadati long-form", { model: options.model, ...usage, costUsd: computeModelCostUsd(tier, usage).toFixed(4) });

  const clips = videos.map((v, i): RankedLongformClip => {
    const meta = byIndex.get(i);
    // Un video senza metadati validi resta comunque: il taglio è la parte importante, il titolo si
    // può correggere a mano dalla dashboard.
    const fallbackTitle = `${v.activity}${v.part ? ` (Parte ${v.part})` : ""}`.slice(0, 100);
    return {
      start: v.start,
      end: v.end,
      duration: v.end - v.start,
      title: meta?.title || fallbackTitle,
      hook: meta?.hook || v.topic.slice(0, 200) || fallbackTitle,
      reason: meta?.reason || "Attività intera della live, tagliata dalla mappa del VOD.",
      scores: meta?.scores ?? NEUTRAL_SCORES,
      hashtags: meta?.hashtags ?? [],
      caption: meta?.caption || v.topic.slice(0, 1000) || fallbackTitle,
      badges: meta?.badges ?? [],
    };
  });
  return { clips, usage };
}

const NEUTRAL_SCORES: ClipScores = { hook: 60, retention: 60, emotion: 60, clarity: 60, payoff: 60, virality: 60 };

function describeForPrompt(index: number, v: PlannedVideo, timeline: TimelineBlock[], sorted: TranscriptSegment[]): string {
  const blocks = timeline.filter((b) => b.end > v.start && b.start < v.end).sort((a, b) => a.start - b.start);
  const lines = sorted.filter((s) => s.start >= v.start && s.start < v.end);
  const picked = new Set<number>();
  for (let i = 0; i < Math.min(OPENING_LINES, lines.length); i++) picked.add(i);
  for (let i = Math.max(0, lines.length - CLOSING_LINES); i < lines.length; i++) picked.add(i);
  const middle = lines.length - OPENING_LINES - CLOSING_LINES;
  if (middle > 0) {
    const step = middle / (MIDDLE_LINES + 1);
    for (let k = 1; k <= MIDDLE_LINES; k++) picked.add(OPENING_LINES + Math.floor(step * k));
  }
  const excerpt = [...picked]
    .sort((a, b) => a - b)
    .map((i) => lines[i]!)
    .map((l) => `[${fmt(l.start)}] ${l.text.slice(0, LINE_MAX_CHARS)}`)
    .join("\n");

  return `### Video ${index} — ${v.activity}${v.part ? ` (Parte ${v.part})` : ""}
Tipo: ${v.kind} · ${fmt(v.start)}-${fmt(v.end)} (${Math.round((v.end - v.start) / 60)} minuti)
Contenuto: ${v.topic}
Mappa della live dentro questo video:
${blocks.map((b) => `- ${fmt(Math.max(b.start, v.start))} ${b.kind}: ${b.what}`).join("\n") || "- (nessun blocco)"}
Estratti del parlato:
${excerpt}`;
}

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { TranscriptSegment, ModelTokenUsage } from "@clipforge/shared";
import { classifyModelTier, computeModelCostUsd } from "@clipforge/shared";
import { getAnthropicClient, cachedSystemPrompt, readCacheUsage, toolChoiceFor, createMessageCached } from "./anthropic-client.js";
import { env } from "../../env.js";
import { formatChapters, type TwitchChapter } from "../../lib/twitch-chapters.js";
import { logger } from "../../lib/logger.js";

/**
 * Mappa di un VOD intero in video long-form.
 *
 * Sostituisce il vecchio passaggio a finestre da 45 minuti con Haiku: ogni finestra vedeva solo il
 * suo pezzo, quindi quando un gioco la attraversava il confine lo decideva la finestra e non il
 * gioco — osservato su 6 VOD reali: tagli esatti a 0:45:00, 1:20:00, 1:55:00, 2:20:00, 2:55:00,
 * 3:40:00 (i bordi delle finestre), clip sovrapposte, giochi diversi fusi nello stesso video.
 *
 * Divisione dei compiti:
 * - il modello legge TUTTO il transcript (un VOD di 6 ore sono ~75-120k token, ci sta) e ne fa
 *   una timeline: blocchi consecutivi, ognuno con un tipo (preparazione, ruota, partita,
 *   reaction...) e l'ATTIVITÀ a cui appartiene. È la parte descrittiva, in cui è affidabile;
 * - i video li costruisce il codice da quella timeline (buildVideosFromTimeline), con le regole
 *   decise da simo. Al primo giro di test i video li sceglieva il modello, e tra due esecuzioni
 *   sullo stesso VOD cambiavano: due reaction diverse fuse insieme, una reaction inghiottita da un
 *   gioco, un torneo da 4h39m mai diviso, un gioco da 24 minuti dimenticato.
 *
 * I confini che escono da qui sono al livello del transcript (righe da ~25s): la rifinitura al
 * secondo la fa longform-boundaries.ts.
 */

export type PlannedVideoKind = "game" | "tournament" | "reaction" | "talk";

export interface PlannedVideo {
  start: number;
  end: number;
  kind: PlannedVideoKind;
  /** Il nome dell'attività ("Black Ops 2", "Torneo Impossibile", "reaction: documentario sui Sadhu"). */
  activity: string;
  /** Cosa contiene, per il titolo: attività + i blocchi che ci sono dentro. */
  topic: string;
  /** Descrizione di come comincia (il primo blocco): guida la rifinitura del confine. */
  opening: string;
  /** Descrizione di come finisce (l'ultimo blocco). */
  closing: string;
  /** Vecchi piani divisi in parti (prima del 2026-10-25): 1, 2, 3... */
  part?: number;
  /** Solo per i giochi di un torneo: il nome del torneo. I giochi dello stesso torneo si toccano sulla ruota. */
  tournament?: string;
}

const TIMELINE_KINDS = ["wait", "chatter", "setup", "wheel", "game", "tournament_game", "reaction", "talk", "pause", "outro"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineBlock {
  start: number;
  end: number;
  kind: TimelineKind;
  /** Nome dell'attività a cui appartiene il blocco, identico per tutti i suoi blocchi; "" se nessuna. */
  activity: string;
  what: string;
}

export interface LongformPlanResult {
  videos: PlannedVideo[];
  /** La mappa completa del VOD, parti scartate comprese. */
  timeline: TimelineBlock[];
  usage: ModelTokenUsage;
}

const TOOL_NAME = "return_vod_timeline";

/** Sotto questa durata un gioco/reaction/argomento non regge da solo come video. */
export const MIN_VIDEO_SECONDS = 8 * 60;
/**
 * Due tratti della stessa attività separati da meno di così (chiacchiere, una pausa) sono lo
 * stesso video: "se lasciano il gioco per pochi minuti e poi lo riprendono è lo stesso video".
 */
const SAME_ACTIVITY_GAP_SECONDS = 5 * 60;

const TIMELINE_TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Restituisce la timeline completa del VOD.",
  input_schema: {
    type: "object" as const,
    properties: {
      timeline: {
        type: "array",
        description: "Tutto il VOD dall'inizio alla fine, in ordine, blocchi consecutivi senza buchi.",
        items: {
          type: "object",
          properties: {
            start: { type: "number", description: "Secondi, presi da una riga del transcript." },
            end: { type: "number", description: "Secondi, presi da una riga del transcript." },
            kind: { type: "string", enum: [...TIMELINE_KINDS] },
            activity: {
              type: "string",
              description:
                "Il nome dell'attività a cui il blocco appartiene, SCRITTO IDENTICO in tutti i blocchi della stessa attività (\"Black Ops 2\", \"Torneo Impossibile\", \"reaction: documentario sui Sadhu\", \"reaction: TikTok\", \"talk: furto negli spogliatoi degli Stallions\"). Stringa vuota per wait/chatter/outro che non appartengono a niente.",
            },
            what: {
              type: "string",
              description:
                "Cosa succede in questo blocco, specifico. Per una partita (game o tournament_game) comincia SEMPRE col nome del gioco seguito da due punti, scritto identico in tutte le partite allo stesso gioco (\"Fortnite: vincono il primo round\"): un torneo viene diviso in un video per gioco usando questo nome.",
            },
          },
          required: ["start", "end", "kind", "activity", "what"],
        },
      },
    },
    required: ["timeline"],
  },
};

const SYSTEM_PROMPT = `Sei il montatore di un canale YouTube che ripubblica le live Twitch di streamer italiani (giochi di gruppo, tornei, reaction) come video long-form. Ricevi il transcript COMPLETO di un VOD (righe "[secondi] testo", ogni riga copre ~25 secondi) e, quando disponibili, i CAPITOLI TWITCH: i cambi di categoria impostati dallo streamer, con i secondi esatti.

Il tuo compito è la TIMELINE del VOD: dividerlo tutto, dall'inizio alla fine, in blocchi consecutivi, e per ogni blocco dire che tipo è e a quale attività appartiene. Da questa timeline verranno poi tagliati i video (un video per attività), quindi quello che conta di più è DOVE comincia e finisce ogni attività e che nessun blocco sia assegnato all'attività sbagliata.

TIPI DI BLOCCO
- wait: attesa prima che la live parta davvero.
- chatter: chiacchiere senza un argomento preciso.
- setup: preparazione di ciò che segue — l'annuncio ("ora giochiamo a...", "adesso guardiamo..."), la lobby, il download, le impostazioni, la spiegazione delle regole di un torneo.
- wheel: giro della ruota (o sorteggio) che sceglie il prossimo gioco.
- game: partita a un gioco, fuori da un torneo.
- tournament_game: partita dentro un torneo.
- reaction: reaction a un video, un documentario, una sessione di TikTok/reel.
- talk: un argomento vero e sostenuto (una storia, una polemica, una discussione su un fatto preciso).
- pause: pausa o problema tecnico.
- outro: saluti finali.

ATTIVITÀ — la regola più importante
- Un'attività è UNA cosa specifica: un gioco ("Black Ops 2"), un torneo ("Torneo Impossibile"), una cosa reagita ("reaction: documentario sui Sadhu"), un argomento ("talk: furto negli spogliatoi degli Stallions"). Scrivi il suo nome IDENTICO in tutti i suoi blocchi.
- setup e wheel prendono l'attività di ciò che PREPARANO, non di ciò che è appena finito: la ruota che sceglie Fortnite appartiene a Fortnite (o al torneo, se è dentro un torneo); l'annuncio "ora guardiamo il documentario" appartiene alla reaction al documentario.
- TORNEO ("Torneo Impossibile", "Torneo della Porc*Madonna", "Torneo P.M."... riconoscibile da regole, punteggi, classifica, ruota che sceglie i giochi): TUTTI i suoi blocchi hanno l'attività del torneo — presentazione e regole, ogni giro della ruota, ogni partita (tournament_game, con il gioco in "what"), le pause e le chiacchiere fra una partita e l'altra, fino al risultato finale/la classifica.
- Giochi diversi sono attività diverse anche se consecutivi e dello stesso genere. Reaction diverse sono attività diverse (due video YouTube diversi = due attività), tranne una sessione di TikTok/reel che è un'attività sola anche con decine di TikTok.
- Se durante un gioco/una reaction si distraggono qualche minuto e poi tornano alla stessa cosa, i blocchi dopo hanno la stessa attività di prima. Una reaction finisce quando la chiudono: le chiacchiere dopo non ne fanno parte.
- Un gioco scelto con la ruota comincia dalla ruota: la ruota non va mai lasciata fuori dall'attività che sceglie.

COME USARE I CAPITOLI TWITCH
- Un cambio di categoria (es. "Just Chatting" -> "Fortnite") è la prova che lì attorno si cambia gioco. Lo streamer lo cambia a mano: di solito entro 1-3 minuti dal cambio vero, a volte prima (mentre il gioco carica), a volte dopo. Il confine preciso lo trovi nel transcript.
- "Just Chatting" non è un'attività: dentro ci sono chiacchiere, reaction diverse, TikTok, ruote, regole di un torneo. Lì i confini li trovi solo dal transcript.
- Brevi "Just Chatting" di 1-2 minuti fra due giochi sono quasi sempre la scelta/l'annuncio del gioco successivo (setup o wheel del gioco che segue).
- Senza capitoli, fai tutto dal transcript con le stesse regole.

VINCOLI: start/end sono secondi presi da righe del transcript, mai inventati. I blocchi coprono tutto il VOD, in ordine, senza buchi né sovrapposizioni. Rispondi chiamando lo strumento ${TOOL_NAME}.`;

const timelineBlockSchema = z.object({
  start: z.number(),
  end: z.number(),
  // Un tipo fuori elenco non deve far cadere tutta la mappa: diventa "chatter", il più neutro.
  kind: z.enum(TIMELINE_KINDS).catch("chatter"),
  activity: z.string().default(""),
  what: z.string(),
});

// A volte il modello restituisce la lista come TESTO JSON invece che come lista (visto al test:
// primo tentativo scartato e ripagato per intero). Si legge il testo invece di rifare la chiamata.
const timelineResponseSchema = z.object({
  timeline: z.preprocess((v) => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }, z.array(timelineBlockSchema).min(1)),
});

export interface LongformPlanOptions {
  apiKey: string;
  model: string;
  videoTitle: string;
  streamerName: string | null;
  videoDurationSeconds: number;
  chapters: TwitchChapter[];
}

export async function planLongformVideos(segments: TranscriptSegment[], options: LongformPlanOptions): Promise<LongformPlanResult> {
  const client = getAnthropicClient(options.apiKey);
  const transcriptText = [...segments]
    .sort((a, b) => a.start - b.start)
    .map((s) => `[${Math.round(s.start)}] ${s.text}`)
    .join("\n");

  const userPrompt = `VOD: "${options.videoTitle}"${options.streamerName ? ` — streamer: ${options.streamerName}` : ""}
Durata: ${Math.round(options.videoDurationSeconds)}s (${(options.videoDurationSeconds / 3600).toFixed(1)} ore)

CAPITOLI TWITCH:
${options.chapters.length > 0 ? formatChapters(options.chapters) : "(non disponibili per questo VOD)"}

TRANSCRIPT COMPLETO:
${transcriptText}`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  const usage: ModelTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const message = await createMessageCached(client, {
      model: options.model,
      max_tokens: 16000,
      system: cachedSystemPrompt(SYSTEM_PROMPT),
      messages,
      tools: [TIMELINE_TOOL_SCHEMA],
      tool_choice: toolChoiceFor(options.model, TOOL_NAME),
    }, { batch: env.ANTHROPIC_BATCH_VOD === "on", label: "mappa del VOD", cache: "mappa-vod" });
    usage.calls++;
    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    const cache = readCacheUsage(message.usage);
    usage.cacheRead += cache.cacheRead;
    usage.cacheWrite += cache.cacheWrite;

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME,
    );
    const parsed = toolUse ? timelineResponseSchema.safeParse(toolUse.input) : null;
    if (!toolUse || !parsed?.success) {
      logger.warn("Timeline del VOD non valida, nuovo tentativo", {
        attempt,
        stopReason: message.stop_reason,
        issues: parsed && !parsed.success ? parsed.error.issues.slice(0, 5) : undefined,
      });
      if (toolUse) {
        messages.push({ role: "assistant", content: message.content });
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: `Output non valido. Richiama ${TOOL_NAME} rispettando lo schema.` }],
        });
      }
      continue;
    }

    const timeline = parsed.data.timeline
      .map((b) => ({ ...b, start: Math.max(0, b.start), end: Math.min(options.videoDurationSeconds, b.end), activity: b.activity.trim() }))
      .filter((b) => b.end > b.start)
      .sort((a, b) => a.start - b.start);
    const videos = buildVideosFromTimeline(timeline);

    const tier = classifyModelTier(options.model) ?? "sonnet";
    logger.info("Mappa del VOD pronta", {
      videos: videos.map((v) => `${fmt(v.start)}-${fmt(v.end)} [${v.kind}] ${v.topic}`),
      timelineBlocks: timeline.length,
      ...usage,
      costUsd: computeModelCostUsd(tier, usage).toFixed(4),
    });

    return { videos, timeline, usage };
  }

  throw new Error("La timeline del VOD non è stata prodotta dopo 2 tentativi");
}

/** Chiave di confronto delle attività: il modello a volte cambia maiuscole/spazi fra un blocco e l'altro. */
function activityKey(activity: string): string {
  return activity.toLowerCase().replace(/[^a-z0-9à-ù]+/g, " ").trim();
}

interface ActivityGroup {
  activity: string;
  blocks: TimelineBlock[];
}

/**
 * Dalla timeline ai video, con le regole di simo:
 * - un video per attività: i suoi blocchi consecutivi (anche interrotti da meno di
 *   SAME_ACTIVITY_GAP_SECONDS di altro) sono un video solo;
 * - setup e ruota ne fanno parte perché hanno la sua attività: il video comincia dalla ruota;
 * - un'attività sotto MIN_VIDEO_SECONDS (o fatta solo di preparazione) non diventa un video;
 * - mai divisa in parti, anche se dura ore: la accorcia il montaggio (simo, 2026-10-25: "se UN SOLO
 *   argomento dura tanto, lo deve far durare tutto unico");
 * - un torneo diventa un video per gioco (splitTournamentByGame).
 */
export function buildVideosFromTimeline(timeline: TimelineBlock[]): PlannedVideo[] {
  const groups: ActivityGroup[] = [];
  const open = new Map<string, ActivityGroup>();

  for (const block of timeline) {
    const key = activityKey(block.activity);
    if (!key) continue;
    const group = open.get(key);
    const lastEnd = group ? group.blocks[group.blocks.length - 1]!.end : -Infinity;
    // Un'altra attività VERA in mezzo (non chiacchiere/pausa) chiude il gruppo: A, B, A sono tre
    // video, non uno che contiene B.
    const otherActivityInBetween = timeline.some(
      (b) => b.start >= lastEnd - 1 && b.end <= block.start + 1 && activityKey(b.activity) && activityKey(b.activity) !== key,
    );
    if (group && block.start - lastEnd <= SAME_ACTIVITY_GAP_SECONDS && !otherActivityInBetween) {
      group.blocks.push(block);
    } else {
      const created = { activity: block.activity, blocks: [block] };
      groups.push(created);
      open.set(key, created);
    }
  }

  const videos: PlannedVideo[] = [];
  for (const group of groups) {
    const kinds = new Set(group.blocks.map((b) => b.kind));
    const kind: PlannedVideoKind | null = kinds.has("tournament_game")
      ? "tournament"
      : kinds.has("game")
        ? "game"
        : kinds.has("reaction")
          ? "reaction"
          : kinds.has("talk")
            ? "talk"
            : null;
    const first = group.blocks[0]!;
    const last = group.blocks[group.blocks.length - 1]!;
    const duration = last.end - first.start;
    if (!kind) {
      logger.info("Attività senza contenuto vero (solo preparazione/chiacchiere), niente video", { activity: group.activity });
      continue;
    }
    if (duration < MIN_VIDEO_SECONDS) {
      logger.info("Attività troppo corta per un video", { activity: group.activity, seconds: Math.round(duration) });
      continue;
    }
    videos.push(...(kind === "tournament" ? splitTournamentByGame(group) : [toVideo(group, group.blocks, kind)]));
  }
  return videos;
}

/** Il gioco di una partita, dalla descrizione del blocco ("Fortnite: secondo round" → "Fortnite"). */
const gameOf = (block: TimelineBlock) => block.what.split(/[(:,—-]/)[0]!.trim();

function toVideo(group: ActivityGroup, blocks: TimelineBlock[], kind: PlannedVideoKind): PlannedVideo {
  return {
    start: blocks[0]!.start,
    end: blocks[blocks.length - 1]!.end,
    kind,
    activity: group.activity,
    topic: group.activity,
    opening: blocks[0]!.what,
    closing: blocks[blocks.length - 1]!.what,
  };
}

/**
 * Un torneo diventa un video per gioco (simo, 2026-10-25: "quando fanno i tornei voglio che li
 * divida per gioco, anche se è un torneo unico"). La preparazione e la ruota stanno col gioco che
 * scelgono, così ogni video parte dalla ruota (regola di simo: la ruota non si taglia mai fuori);
 * più partite di fila allo stesso gioco restano un video solo; classifica e saluti finali chiudono
 * l'ultimo. Un gioco troppo corto per reggere da solo si unisce a quello prima.
 */
function splitTournamentByGame(group: ActivityGroup): PlannedVideo[] {
  const pieces: Array<{ game: string; blocks: TimelineBlock[] }> = [];
  let pending: TimelineBlock[] = [];
  for (const block of group.blocks) {
    if (block.kind !== "tournament_game" && block.kind !== "game") {
      pending.push(block);
      continue;
    }
    const game = gameOf(block);
    const last = pieces[pieces.length - 1];
    if (last && activityKey(last.game) === activityKey(game)) last.blocks.push(...pending, block);
    else pieces.push({ game, blocks: [...pending, block] });
    pending = [];
  }
  if (pieces.length === 0) return [toVideo(group, group.blocks, "tournament")];
  pieces[pieces.length - 1]!.blocks.push(...pending);

  const merged: typeof pieces = [];
  for (const piece of pieces) {
    const duration = piece.blocks[piece.blocks.length - 1]!.end - piece.blocks[0]!.start;
    const previous = merged[merged.length - 1];
    if (previous && duration < MIN_VIDEO_SECONDS) {
      previous.game = `${previous.game} + ${piece.game}`;
      previous.blocks.push(...piece.blocks);
    } else merged.push(piece);
  }
  // Il primo, se è troppo corto, va col secondo.
  if (merged.length > 1 && merged[0]!.blocks[merged[0]!.blocks.length - 1]!.end - merged[0]!.blocks[0]!.start < MIN_VIDEO_SECONDS) {
    const first = merged.shift()!;
    merged[0] = { game: `${first.game} + ${merged[0]!.game}`, blocks: [...first.blocks, ...merged[0]!.blocks] };
  }

  const videos = merged.map((piece) => ({
    ...toVideo({ activity: piece.game, blocks: piece.blocks }, piece.blocks, "tournament"),
    topic: `${piece.game} (partita del torneo "${group.activity}")`,
    tournament: group.activity,
  }));
  logger.info("Torneo diviso per gioco", { tournament: group.activity, videos: videos.map((v) => `${fmt(v.start)}-${fmt(v.end)} ${v.activity}`) });
  return videos;
}

export function fmt(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

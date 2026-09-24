import { runYtDlp } from "./yt-dlp.js";
import { logger } from "./logger.js";

/** Un cambio di categoria di un VOD Twitch ("Just Chatting", "Fortnite", ...), in secondi dall'inizio del VOD. */
export interface TwitchChapter {
  start: number;
  end: number;
  title: string;
}

/**
 * Capitoli di un VOD Twitch: Twitch registra ogni cambio di categoria fatto dallo streamer e yt-dlp
 * li espone in `chapters`. Sono il segnale più preciso che esista su QUANDO si cambia gioco — il
 * transcript da solo non lo dice se nessuno pronuncia il nome del gioco. Non coprono però i cambi
 * dentro la stessa categoria (due reaction diverse restano entrambe "Just Chatting").
 *
 * Esistono solo finché il VOD è online su Twitch (i VOD scadono): su un VOD sparito, o su un URL
 * non Twitch, ritorna [] e la pipeline prosegue col solo transcript. Mai un errore bloccante.
 */
export async function fetchTwitchChapters(sourceUrl: string | null): Promise<TwitchChapter[]> {
  if (!sourceUrl || !/twitch\.tv\/videos\/\d+/.test(sourceUrl)) return [];

  try {
    const { stdout } = await runYtDlp(["--skip-download", "--dump-single-json", "--no-warnings", sourceUrl], {
      inactivityTimeoutMs: 60_000,
    });
    const info = JSON.parse(stdout) as { chapters?: Array<{ start_time: number; end_time: number; title: string }> | null };
    const chapters = (info.chapters ?? [])
      .filter((c) => Number.isFinite(c.start_time) && Number.isFinite(c.end_time) && c.end_time > c.start_time)
      .map((c) => ({ start: c.start_time, end: c.end_time, title: c.title }));
    logger.info("Capitoli Twitch letti", { sourceUrl, count: chapters.length });
    return chapters;
  } catch (err) {
    logger.warn("Capitoli Twitch non disponibili, si prosegue col solo transcript", {
      sourceUrl,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return [];
  }
}

/** "[0s-5520s] Just Chatting" per riga, per i prompt. */
export function formatChapters(chapters: TwitchChapter[]): string {
  return chapters.map((c) => `[${Math.round(c.start)}s-${Math.round(c.end)}s] ${c.title}`).join("\n");
}

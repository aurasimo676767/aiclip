import { supabase } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { env } from "../env.js";
import { detectGameTimeline, mainGame, type GameSegment } from "../providers/ai/game-timeline.js";

/**
 * Giochi di una clip long-form riconosciuti dallo schermo (vedi game-timeline.ts), salvati in
 * clips.longform_games. Si fanno quando il VOD viene diviso in clip (il sorgente è già sul PC) e,
 * se mancano, al render di un video montato. null se il riconoscimento è spento o fallisce: il
 * montaggio va avanti senza filtro per gioco.
 */
export async function ensureLongformGames(
  clip: { id: string; start_time: number; end_time: number; longform_games?: unknown },
  sourceVideoPath: string,
): Promise<GameSegment[] | null> {
  if (Array.isArray(clip.longform_games) && clip.longform_games.length > 0) return clip.longform_games as GameSegment[];
  if (env.ANTHROPIC_MODEL_GAME_DETECT === "off") return null;
  const timeline = await detectGameTimeline(
    { sourceVideoPath, start: clip.start_time, end: clip.end_time },
    { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL_GAME_DETECT },
  );
  if (!timeline) return null;
  const { error } = await supabase.from("clips").update({ longform_games: timeline }).eq("id", clip.id);
  if (error) {
    // Prima della migrazione 0029 la colonna non c'è: la mappa vale per questo render e basta.
    logger.warn("Mappa dei giochi non salvata", { clipId: clip.id, error: error.message });
  }
  return timeline;
}

/** I giochi da tenere: quelli scelti da simo sul sito, o il gioco che dura di più. */
export function gamesToKeep(timeline: GameSegment[], chosen: unknown): string[] {
  const names = new Set(timeline.map((s) => (s.kind === "altro" ? "Altro" : s.name)));
  const picked = Array.isArray(chosen) ? (chosen as string[]).filter((n) => names.has(n)) : [];
  if (picked.length > 0) return picked;
  const main = mainGame(timeline);
  return main ? [main] : [];
}

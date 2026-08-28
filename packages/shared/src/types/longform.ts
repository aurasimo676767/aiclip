import type { ClipScores, ClipBadge } from "./clip.js";

/**
 * Output del passaggio economico per i video long-form (Claude Haiku): finestre candidate per
 * ARGOMENTO su un VOD lungo, non finestre hook-payoff come per gli Shorts (vedi ClipCandidateWindow).
 */
export interface LongformCandidateWindow {
  start: number;
  end: number;
  /** Breve descrizione dell'argomento trattato in questa finestra. */
  topic: string;
}

/**
 * Output del passaggio forte per i video long-form (Claude Sonnet): niente editing_style/edl
 * (il render long-form è solo trim + card dei crediti, nessun crop/zoom/sottotitoli).
 */
export interface RankedLongformClip {
  start: number;
  end: number;
  duration: number;
  title: string;
  hook: string;
  reason: string;
  scores: ClipScores;
  hashtags: string[];
  /** Usata come descrizione della pubblicazione YouTube, non solo come didascalia breve. */
  caption: string;
  badges: ClipBadge[];
}

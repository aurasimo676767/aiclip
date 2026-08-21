import type { EditDecisionList } from "./edl.js";

/** Stili di editing che l'AI può assegnare a una clip; guidano la scelta del template di default. */
export const EDITING_STYLES = ["dynamic", "clean", "high_energy", "calm"] as const;
export type EditingStyle = (typeof EDITING_STYLES)[number];

export interface ClipScores {
  hook: number;
  retention: number;
  emotion: number;
  clarity: number;
  payoff: number;
  virality: number;
}

/**
 * Output del passaggio economico (Claude Haiku): finestre candidate individuate nel transcript.
 * Volutamente minimale — niente scores o EDL, calcolati solo per i candidati che superano
 * il ranking finale, per contenere i costi.
 */
export interface ClipCandidateWindow {
  start: number;
  end: number;
  hook: string;
  reason: string;
}

/**
 * Output del passaggio forte (Claude Sonnet): clip finale con punteggi ed EDL.
 * Rispecchia esattamente la struttura richiesta per l'AI clipping engine.
 */
export interface RankedClip {
  start: number;
  end: number;
  duration: number;
  hook: string;
  title: string;
  reason: string;
  scores: ClipScores;
  /** snake_case intenzionale: rispecchia 1:1 il campo restituito dall'AI e la colonna DB `editing_style`. */
  editing_style: EditingStyle;
  edl: EditDecisionList;
  /** Hashtag suggeriti per la pubblicazione (senza #), generati nello stesso passaggio di ranking. */
  hashtags: string[];
  /**
   * Didascalia pronta per la pubblicazione (YouTube/TikTok): breve, divertente, in linguaggio
   * naturale/slang, pensata per essere letta dal pubblico. Diversa da `reason`, che è invece
   * una spiegazione interna (per la dashboard) del perché la clip funziona.
   */
  caption: string;
}

/** Media (0-100) dei sei punteggi, usata come "score" complessivo mostrato in dashboard. */
export function overallScore(scores: ClipScores): number {
  const values = Object.values(scores);
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

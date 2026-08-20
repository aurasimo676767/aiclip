/** Durata target di una clip, in secondi. L'AI può deviare leggermente per preservare il senso compiuto. */
export const CLIP_DURATION_TARGET = { min: 30, max: 60, hardMin: 15, hardMax: 90 } as const;

/** Numero massimo di candidati che passano dal filtro economico (Haiku) al ranking forte (Sonnet). */
export const MAX_CANDIDATES_FOR_RANKING = 25;

/** Durata (in secondi) di ciascuna finestra di transcript inviata al passaggio economico di candidate detection. */
export const CANDIDATE_CHUNK_WINDOW_SECONDS = 600; // 10 minuti

/** Overlap tra finestre consecutive per non perdere momenti a cavallo di un confine di chunk. */
export const CANDIDATE_CHUNK_OVERLAP_SECONDS = 45;

/** Numero massimo di clip finali suggerite mostrate all'utente dopo il ranking. */
export const MAX_SUGGESTED_CLIPS = 30;

export const DEFAULT_CHEAP_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_STRONG_MODEL = "claude-sonnet-5";

/** Formato di output verticale standard (YouTube Shorts / TikTok / Reels). */
export const OUTPUT_RESOLUTION = { width: 1080, height: 1920 } as const;

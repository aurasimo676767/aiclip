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

// Un segmento long-form è un intero BLOCCO DI ATTIVITÀ (es. "tutta la reaction ai TikTok",
// "tutta la sessione di gioco a X"), non un momento narrativo dentro di esso — vedi il prompt in
// longform-candidates.ts, che è la fonte di verità per come viene applicato questo target.
export const LONGFORM_DURATION_TARGET = { min: 600, max: 2400, hardMin: 300, hardMax: 2700 } as const;

// Finestre larghe (45 min, molto più delle 10 degli Shorts): un blocco di attività può durare
// 30-40 minuti da solo, la finestra dev'essere abbastanza larga da contenerlo per intero — con
// un overlap generoso (10 min) per non spezzarlo comunque a un confine sfortunato.
export const LONGFORM_CHUNK_WINDOW_SECONDS = 2700; // 45 minuti

export const LONGFORM_CHUNK_OVERLAP_SECONDS = 600; // 10 minuti

/** Numero massimo di segmenti long-form suggeriti per VOD dopo il ranking. */
export const MAX_SUGGESTED_LONGFORM_CLIPS = 15;

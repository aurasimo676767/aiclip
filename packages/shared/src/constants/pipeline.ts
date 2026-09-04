/**
 * Durata target di una clip Shorts, in secondi. L'AI può deviare leggermente per preservare il
 * senso compiuto, ma hardMax è un tetto rigido: se il momento "gancio" naturale è più lungo,
 * l'AI deve tagliare più aggressivamente attorno ad esso invece di includere tutto il contesto
 * (vedi enforceHardDurationCap in process-video-job.ts per l'enforcement lato codice, non solo
 * a livello di prompt). Non tocca LONGFORM_DURATION_TARGET, che resta un target separato per la
 * pipeline VOD/long-form.
 *
 * min/hardMin alzati (15→20, 8→12) dopo aver osservato in produzione che il taglio "senza
 * pietà" spingeva quasi tutte le clip reali verso 10-20s: il gancio c'era ma finiva subito dopo,
 * senza spazio per lo sviluppo/la reazione — risultato percepito come poco divertente/piatto.
 * Il gancio da solo non basta, serve anche il payoff dopo (vedi SYSTEM_PROMPT in ranking.ts).
 */
export const CLIP_DURATION_TARGET = { min: 20, max: 30, hardMin: 12, hardMax: 30 } as const;

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

/**
 * Prezzi Anthropic in $ per milione di token (controllati il 2026-08-30) — usati per calcolare il
 * costo REALE (non stimato) di ogni run, a partire dai token effettivi restituiti dall'API
 * (message.usage). Aggiorna questi numeri se Anthropic cambia i prezzi: sono usati sia dal worker
 * (per calcolare il costo da salvare in videos.usage_stats) sia dal sito (per la label "$/MTok"
 * mostrata all'utente).
 *
 * Chiavi per "livello" (haiku/sonnet/opus), non per ID modello esatto: ANTHROPIC_MODEL_STRONG e
 * ANTHROPIC_MODEL_LONGFORM sono configurabili in .env e possono puntare a modelli diversi (oggi
 * gli Shorts usano Opus 5, il long-form Sonnet 5 di default) — vedi classifyModelTier in
 * usage-stats.ts, che mappa l'ID modello effettivo a una di queste chiavi.
 */
export const MODEL_PRICING_USD_PER_MTOK = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 2, output: 10 },
  opus: { input: 5, output: 25 },
} as const;

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

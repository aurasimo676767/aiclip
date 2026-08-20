/**
 * Stato del video/progetto lungo l'intera pipeline di analisi.
 * Non include il rendering delle singole clip: quello è tracciato da RenderJobStatus.
 */
export const VIDEO_STATUSES = [
  "UPLOADING",
  "UPLOADED",
  "DOWNLOADING",
  "EXTRACTING_AUDIO",
  "TRANSCRIBING",
  "ANALYZING",
  "CLIP_SELECTION",
  "READY",
  "FAILED",
] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];

/** Stato di un singolo job di render di una clip selezionata dall'utente. */
export const RENDER_JOB_STATUSES = [
  "PENDING",
  "RENDERING",
  "COMPLETED",
  "FAILED",
] as const;

export type RenderJobStatus = (typeof RENDER_JOB_STATUSES)[number];

/** Stato di una clip suggerita dall'AI, indipendente dal suo render job. */
export const CLIP_STATUSES = [
  "SUGGESTED",
  "QUEUED",
  "RENDERING",
  "COMPLETED",
  "FAILED",
] as const;

export type ClipStatus = (typeof CLIP_STATUSES)[number];

export interface FailableEntity {
  status: string;
  errorMessage: string | null;
}

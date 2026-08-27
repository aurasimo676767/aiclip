/** Tipi MIME video accettati in upload. */
export const ALLOWED_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime", // .mov
  "video/x-matroska", // .mkv
  "video/webm",
] as const;

export type AllowedVideoMimeType = (typeof ALLOWED_VIDEO_MIME_TYPES)[number];

export function isAllowedVideoMimeType(mime: string): mime is AllowedVideoMimeType {
  return (ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(mime);
}

/** Default assoluto (indipendente dal piano) usato come hard cap lato API. */
export const HARD_MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5GB

/** Tipi MIME audio accettati per il voice over (vedi dashboard/whop). */
export const ALLOWED_AUDIO_MIME_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/m4a", "audio/mp4"] as const;

export type AllowedAudioMimeType = (typeof ALLOWED_AUDIO_MIME_TYPES)[number];

export function isAllowedAudioMimeType(mime: string): mime is AllowedAudioMimeType {
  return (ALLOWED_AUDIO_MIME_TYPES as readonly string[]).includes(mime);
}

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

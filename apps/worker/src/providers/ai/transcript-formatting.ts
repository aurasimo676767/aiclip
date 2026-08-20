import type { TranscriptSegment } from "@clipforge/shared";

/** Formatta i segmenti in righe compatte "[start-end] testo" per i prompt AI (a livello di segmento, non di parola, per contenere i token). */
export function formatSegments(segments: TranscriptSegment[]): string {
  return segments
    .map((seg) => `[${seg.start.toFixed(1)}-${seg.end.toFixed(1)}]${seg.speaker ? ` ${seg.speaker}:` : ""} ${seg.text}`)
    .join("\n");
}

export function segmentsInWindow(segments: TranscriptSegment[], startSeconds: number, endSeconds: number): TranscriptSegment[] {
  return segments.filter((seg) => seg.end > startSeconds && seg.start < endSeconds);
}

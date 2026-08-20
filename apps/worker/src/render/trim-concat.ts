import { runFfmpeg } from "../lib/ffmpeg.js";
import type { TimeSegment } from "./silence.js";

/**
 * Rimuove da un file video i segmenti NON presenti in `keepSegments` (tipicamente le pause
 * di silenzio in eccesso) tagliando e riconcatenando video+audio in un unico filtergraph,
 * cosi' che restino perfettamente sincronizzati.
 */
export async function trimToKeepSegments(inputPath: string, outputPath: string, keepSegments: TimeSegment[]): Promise<void> {
  if (keepSegments.length === 0) {
    throw new Error("trimToKeepSegments: nessun segmento da mantenere");
  }

  const videoParts: string[] = [];
  const audioParts: string[] = [];
  const labels: string[] = [];

  keepSegments.forEach((seg, i) => {
    videoParts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
    audioParts.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });

  const filterComplex = [
    ...videoParts,
    ...audioParts,
    `${labels.join("")}concat=n=${keepSegments.length}:v=1:a=1[vout][aout]`,
  ].join(";");

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    outputPath,
  ]);
}

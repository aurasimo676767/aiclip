import { runFfmpegBinary } from "../lib/ffmpeg.js";

export const DETECTOR_INPUT_WIDTH = 320;
export const DETECTOR_INPUT_HEIGHT = 240;

/**
 * Estrae un singolo frame al timestamp indicato come buffer raw BGR24, ridimensionato
 * all'input del modello di face detection (320x240). Nessun file temporaneo: i byte
 * arrivano direttamente su stdout di ffmpeg.
 */
export async function extractRawFrameBGR(videoPath: string, atSeconds: number): Promise<Buffer> {
  return runFfmpegBinary([
    "-ss",
    String(Math.max(0, atSeconds)),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${DETECTOR_INPUT_WIDTH}:${DETECTOR_INPUT_HEIGHT}`,
    "-pix_fmt",
    "bgr24",
    "-f",
    "rawvideo",
    "-",
  ]);
}

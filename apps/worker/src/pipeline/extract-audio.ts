import path from "node:path";
import { runFfmpeg } from "../lib/ffmpeg.js";

/**
 * Estrae l'audio dal video sorgente in un mp3 mono a basso bitrate, ottimizzato per
 * lo speech-to-text (dimensione ridotta, qualità sufficiente per la trascrizione).
 */
export async function extractAudio(videoFilePath: string, outputDir: string): Promise<string> {
  const base = path.basename(videoFilePath, path.extname(videoFilePath));
  const audioPath = path.join(outputDir, `${base}.audio.mp3`);

  await runFfmpeg(["-y", "-i", videoFilePath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioPath]);

  return audioPath;
}

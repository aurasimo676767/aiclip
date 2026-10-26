import path from "node:path";
import { runFfmpeg } from "../lib/ffmpeg.js";

/**
 * Estrae l'audio dal video sorgente per lo speech-to-text: mono 16 kHz in FLAC (senza perdita).
 * Prima era un mp3 a 64 kbit/s: sopra la musica e i suoni dei giochi Whisper ci perdeva quasi tutto
 * il parlato. Misurato il 2026-10-26 sulla pallavolo di Switch Sports: 3 parole invece di 28-33 in un
 * minuto, 10 invece di 68 in un altro; anche su un minuto tutto parlato 146 invece di 179.
 */
export async function extractAudio(videoFilePath: string, outputDir: string): Promise<string> {
  const base = path.basename(videoFilePath, path.extname(videoFilePath));
  const audioPath = path.join(outputDir, `${base}.audio.flac`);

  await runFfmpeg(["-y", "-i", videoFilePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", audioPath]);

  return audioPath;
}

import path from "node:path";
import { probeVideo, runFfmpeg } from "../../lib/ffmpeg.js";

export interface AudioChunk {
  filePath: string;
  offsetSeconds: number;
}

/**
 * L'API Whisper di OpenAI accetta al massimo 25MB per file. Il worker estrae l'audio
 * a bitrate fisso (64kbit/s mono, vedi extract-audio.ts) quindi, se il file supera la
 * durata "sicura" per stare sotto quel limite, lo spezza in finestre di lunghezza fissa
 * prima di trascrivere, per poi ricomporre i timestamp con l'offset corretto.
 */
const SAFE_CHUNK_SECONDS = 1200; // 20 minuti, ~9.6MB a 64kbit/s: ampio margine sotto i 25MB

export async function splitAudioIntoChunks(audioFilePath: string, tmpDir: string): Promise<AudioChunk[]> {
  const probe = await probeVideo(audioFilePath);
  const totalDuration = probe.durationSeconds;

  if (totalDuration <= SAFE_CHUNK_SECONDS) {
    return [{ filePath: audioFilePath, offsetSeconds: 0 }];
  }

  const chunks: AudioChunk[] = [];
  const ext = path.extname(audioFilePath);
  const base = path.basename(audioFilePath, ext);

  let offset = 0;
  let index = 0;
  while (offset < totalDuration) {
    const chunkPath = path.join(tmpDir, `${base}.chunk${index}${ext}`);
    await runFfmpeg(["-y", "-i", audioFilePath, "-ss", String(offset), "-t", String(SAFE_CHUNK_SECONDS), "-c", "copy", chunkPath]);
    chunks.push({ filePath: chunkPath, offsetSeconds: offset });
    offset += SAFE_CHUNK_SECONDS;
    index += 1;
  }

  return chunks;
}

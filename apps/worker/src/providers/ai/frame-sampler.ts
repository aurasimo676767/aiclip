import { runFfmpegBinary } from "../../lib/ffmpeg.js";

// Lato lungo dell'immagine: abbastanza per far giudicare a Claude energia/espressioni/scena,
// non serve leggere testo piccolo — tiene bassi i token immagine (circa 450-700 token/frame
// invece di 1500+ a piena risoluzione, vedi https://platform.claude.com/docs/en/build-with-claude/vision).
const FRAME_LONG_EDGE = 768;

/**
 * Estrae qualche frame JPEG (base64) campionati nella finestra [startSeconds, endSeconds],
 * usati nel passaggio di ranking per far "vedere" all'AI il candidato invece di fargli
 * giudicare solo dal testo del transcript (energia visiva, espressioni, reazioni non sono
 * nel testo). Un frame mancante non fa fallire l'intero ranking — l'AI se la cava anche con
 * meno immagini per quel candidato.
 */
export async function extractCandidateFrameJpegs(videoPath: string, startSeconds: number, endSeconds: number, count: number): Promise<string[]> {
  const duration = Math.max(0.1, endSeconds - startSeconds);
  const timestamps: number[] = [];
  for (let i = 1; i <= count; i++) {
    timestamps.push(startSeconds + (duration * i) / (count + 1));
  }

  const frames: string[] = [];
  for (const t of timestamps) {
    try {
      const buffer = await runFfmpegBinary(
        [
          "-ss",
          String(Math.max(0, t)),
          "-i",
          videoPath,
          "-frames:v",
          "1",
          "-vf",
          `scale=${FRAME_LONG_EDGE}:${FRAME_LONG_EDGE}:force_original_aspect_ratio=decrease`,
          "-q:v",
          "4",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "-",
        ],
        { timeoutMs: 30 * 1000 },
      );
      frames.push(buffer.toString("base64"));
    } catch {
      // vedi commento sopra la funzione
    }
  }
  return frames;
}

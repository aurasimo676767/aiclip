import path from "node:path";
import * as ort from "onnxruntime-node";
import { runFfmpegBinary } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";
import type { FaceBox } from "./onnx-face-detector.js";

/**
 * Chi sta parlando DAVVERO, webcam per webcam: Light-ASD (github.com/Junhua-Liao/Light-ASD,
 * licenza MIT, pesi "finetuning_TalkSet"), un modello addestrato apposta a dire se il volto che
 * vede è quello della voce che si sente. Guarda insieme la bocca (25 fotogrammi al secondo) e
 * l'audio, quindi chi è mutato e muove la bocca per i fatti suoi NON risulta che parla: la sua
 * bocca non va a tempo con la voce. Esportato in ONNX (models/light-asd-talkset.onnx) per girare
 * in locale senza PyTorch, gratis.
 *
 * Prima si usava la sola differenza di pixel nella zona della bocca (mouth-motion.ts): misurato
 * sul video di Blur con 4 webcam (simo, 2026-10-25), su webcam così piccole e compresse non dice
 * niente — la bocca di chi muove la testa o è mutato vinceva su chi parlava.
 *
 * Ingressi come nella demo del modello (Columbia_test.py): volto in grigio 112x112 a 25 fps,
 * ritagliato attorno a naso-bocca; audio MFCC a 13 coefficienti, 100 al secondo, calcolati come
 * python_speech_features (stessi parametri di default, sui campioni int16 non normalizzati).
 */

const MODEL_PATH = path.resolve(process.cwd(), "models", "light-asd-talkset.onnx");
const VIDEO_FPS = 25;
const AUDIO_RATE = 16000;
const FACE_SIZE = 112;
/** Lunghezze (secondi) dei pezzi su cui si valuta, con quante volte contano: come la demo ({1,1,1,2,2,2,3,3,4,5,6}). */
const DURATIONS: Array<[seconds: number, weight: number]> = [
  [1, 3],
  [2, 3],
  [3, 2],
  [4, 1],
  [5, 1],
  [6, 1],
];

let sessionPromise: Promise<ort.InferenceSession> | null = null;
/**
 * Sulla scheda video (DirectML) quando c'è: misurato sul PC di simo, 4 webcam per 24 s di clip
 * passano da quasi 2 minuti su CPU (che il PC divide con tutto il resto) a pochi secondi. Se
 * DirectML non parte, CPU con 4 thread (con tutti i core si pestava i piedi con gli altri processi).
 */
function getSession(): Promise<ort.InferenceSession> {
  sessionPromise ??= ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["dml"] }).catch((err) => {
    logger.warn("Modello chi-parla: DirectML non disponibile, uso la CPU", { error: err instanceof Error ? err.message : String(err) });
    return ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["cpu"], intraOpNumThreads: 4 });
  });
  return sessionPromise;
}

export interface ActiveSpeakerScores {
  /** scores[k][f]: quanto il volto k sta parlando nel fotogramma f (25 fps dall'inizio). >0 = parla. */
  scores: number[][];
  fps: number;
}

/** Ritaglio come la demo: quadrato di lato 0,7 volte il volto, centrato un po' sotto il centro (naso-bocca). */
function faceCrop(box: FaceBox, sourceWidth: number, sourceHeight: number): { x: number; y: number; side: number } {
  const size = Math.max(box.width, box.height);
  const side = Math.max(8, Math.min(sourceWidth, sourceHeight, Math.round(size * 0.7)));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2 + size * 0.2;
  const x = Math.round(Math.min(sourceWidth - side, Math.max(0, cx - side / 2)));
  const y = Math.round(Math.min(sourceHeight - side, Math.max(0, cy - side / 2)));
  return { x, y, side };
}

/** La clip si analizza a finestre: i fotogrammi dei volti di una finestra stanno in memoria tutti insieme. */
const WINDOW_SECONDS = 30;
/** Fotogrammi per chiamata al modello (somma su tutti i pezzi del lotto): ~75 MB di ingresso. */
const MAX_FRAMES_PER_CALL = 1500;

/**
 * Punteggio "sta parlando" di ogni volto, fotogramma per fotogramma (25 fps). I volti sono le
 * webcam della clip (riquadro medio: la webcam è ferma, la persona si sposta poco).
 */
export async function scoreActiveSpeakers(
  videoPath: string,
  startSeconds: number,
  durationSeconds: number,
  faces: FaceBox[],
  sourceWidth: number,
  sourceHeight: number,
): Promise<ActiveSpeakerScores> {
  const scores: number[][] = faces.map(() => []);
  if (faces.length === 0) return { scores, fps: VIDEO_FPS };
  for (let offset = 0; offset < durationSeconds - 0.2; offset += WINDOW_SECONDS) {
    const len = Math.min(WINDOW_SECONDS, durationSeconds - offset);
    const part = await scoreWindow(videoPath, startSeconds + offset, len, faces, sourceWidth, sourceHeight);
    part.forEach((s, k) => {
      for (const v of s) scores[k]!.push(v);
    });
  }
  return { scores, fps: VIDEO_FPS };
}

async function scoreWindow(
  videoPath: string,
  startSeconds: number,
  durationSeconds: number,
  faces: FaceBox[],
  sourceWidth: number,
  sourceHeight: number,
): Promise<number[][]> {
  const n = faces.length;
  const crops = faces.map((f) => {
    const c = faceCrop(f, sourceWidth, sourceHeight);
    return `crop=${c.side}:${c.side}:${c.x}:${c.y},scale=${FACE_SIZE}:${FACE_SIZE}:flags=area,format=gray`;
  });
  const graph =
    n === 1
      ? `[0:v]fps=${VIDEO_FPS},${crops[0]}[out]`
      : `[0:v]fps=${VIDEO_FPS},split=${n}${faces.map((_, k) => `[s${k}]`).join("")};` +
        crops.map((c, k) => `[s${k}]${c}[m${k}]`).join(";") +
        `;${faces.map((_, k) => `[m${k}]`).join("")}hstack=inputs=${n}[out]`;
  const timeoutMs = Math.max(60_000, durationSeconds * 2000);
  const [raw, pcm] = await Promise.all([
    runFfmpegBinary(
      ["-ss", String(Math.max(0, startSeconds)), "-t", String(durationSeconds), "-i", videoPath, "-filter_complex", graph, "-map", "[out]", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
      { timeoutMs },
    ),
    runFfmpegBinary(
      ["-ss", String(Math.max(0, startSeconds)), "-t", String(durationSeconds), "-i", videoPath, "-vn", "-ac", "1", "-ar", String(AUDIO_RATE), "-f", "s16le", "-"],
      { timeoutMs },
    ),
  ]);

  const rowWidth = FACE_SIZE * n;
  const frameBytes = rowWidth * FACE_SIZE;
  const facePixels = FACE_SIZE * FACE_SIZE;
  const videoFrames = Math.floor(raw.length / frameBytes);
  const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + Math.floor(pcm.length / 2) * 2));
  const mfcc = computeMfcc(samples);
  const audioFrames = mfcc.length / 13;

  // Stessa lunghezza per audio e video (4 righe MFCC per fotogramma), come nella demo.
  const T = Math.floor(Math.min((audioFrames - (audioFrames % 4)) / 100, videoFrames / VIDEO_FPS) * VIDEO_FPS);
  // Senza audio (o pezzo cortissimo) nessuno parla: punteggio negativo, così vince il proprietario.
  if (T < 5) return faces.map(() => Array.from({ length: Math.round(durationSeconds * VIDEO_FPS) }, () => -1));

  const session = await getSession();
  const total = faces.map(() => new Float64Array(T));
  const weightAt = faces.map(() => new Float64Array(T));

  /** Esegue il modello su un lotto di pezzi lunghi `len` fotogrammi che iniziano a `starts` (uno per volto e pezzo). */
  const runBatch = async (items: Array<{ k: number; from: number }>, len: number, weight: number) => {
    const visual = new Float32Array(items.length * len * facePixels);
    const audio = new Float32Array(items.length * len * 4 * 13);
    items.forEach(({ k, from }, b) => {
      for (let f = 0; f < len; f++) {
        for (let y = 0; y < FACE_SIZE; y++) {
          const src = (from + f) * frameBytes + y * rowWidth + k * FACE_SIZE;
          const dst = ((b * len + f) * FACE_SIZE + y) * FACE_SIZE;
          for (let x = 0; x < FACE_SIZE; x++) visual[dst + x] = raw[src + x]!;
        }
      }
      audio.set(mfcc.subarray(from * 4 * 13, (from + len) * 4 * 13), b * len * 4 * 13);
    });
    const out = await session.run({
      audio: new ort.Tensor("float32", audio, [items.length, len * 4, 13]),
      visual: new ort.Tensor("float32", visual, [items.length, len, FACE_SIZE, FACE_SIZE]),
    });
    const s = out.score!.data as Float32Array;
    items.forEach(({ k, from }, b) => {
      for (let i = 0; i < len; i++) {
        total[k]![from + i]! += s[b * len + i]! * weight;
        weightAt[k]![from + i]! += weight;
      }
    });
  };

  for (const [duration, weight] of DURATIONS) {
    const chunk = duration * VIDEO_FPS;
    const fullChunks = Math.floor(T / chunk);
    const items: Array<{ k: number; from: number }> = [];
    for (let c = 0; c < fullChunks; c++) for (let k = 0; k < n; k++) items.push({ k, from: c * chunk });
    const perCall = Math.max(1, Math.floor(MAX_FRAMES_PER_CALL / chunk));
    for (let i = 0; i < items.length; i += perCall) await runBatch(items.slice(i, i + perCall), chunk, weight);
    const tail = T - fullChunks * chunk;
    if (tail >= 2) await runBatch(faces.map((_, k) => ({ k, from: fullChunks * chunk })), tail, weight);
  }

  return total.map((t, k) => Array.from(t, (v, i) => (weightAt[k]![i]! > 0 ? v / weightAt[k]![i]! : 0)));
}

// --- MFCC identici a python_speech_features.mfcc(audio, 16000, numcep=13, winlen=0.025, winstep=0.01) ---

const NFFT = 512;
const NFILT = 26;
const FRAME_LEN = 400;
const FRAME_STEP = 160;

let melFilters: Float64Array[] | null = null;
function getMelFilters(): Float64Array[] {
  if (melFilters) return melFilters;
  const hz2mel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
  const mel2hz = (mel: number) => 700 * (Math.pow(10, mel / 2595) - 1);
  const low = hz2mel(0);
  const high = hz2mel(AUDIO_RATE / 2);
  const bins = Array.from({ length: NFILT + 2 }, (_, i) => Math.floor(((NFFT + 1) * mel2hz(low + ((high - low) * i) / (NFILT + 1))) / AUDIO_RATE));
  melFilters = [];
  for (let j = 0; j < NFILT; j++) {
    const fb = new Float64Array(NFFT / 2 + 1);
    for (let i = bins[j]!; i < bins[j + 1]!; i++) fb[i] = (i - bins[j]!) / (bins[j + 1]! - bins[j]!);
    for (let i = bins[j + 1]!; i < bins[j + 2]!; i++) fb[i] = (bins[j + 2]! - i) / (bins[j + 2]! - bins[j + 1]!);
    melFilters.push(fb);
  }
  return melFilters;
}

/** FFT complessa radix-2 in place (n potenza di 2). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Ritorna le righe MFCC appiattite (numFrames x 13). */
export function computeMfcc(samples: Int16Array): Float32Array {
  const emph = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) emph[i] = i === 0 ? samples[0]! : samples[i]! - 0.97 * samples[i - 1]!;
  const numFrames = emph.length <= FRAME_LEN ? 1 : 1 + Math.ceil((emph.length - FRAME_LEN) / FRAME_STEP);
  const filters = getMelFilters();
  const out = new Float32Array(numFrames * 13);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const logFb = new Float64Array(NFILT);
  const pspec = new Float64Array(NFFT / 2 + 1);
  for (let f = 0; f < numFrames; f++) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FRAME_LEN; i++) re[i] = emph[f * FRAME_STEP + i] ?? 0;
    fft(re, im);
    let energy = 0;
    for (let i = 0; i <= NFFT / 2; i++) {
      pspec[i] = (re[i]! * re[i]! + im[i]! * im[i]!) / NFFT;
      energy += pspec[i]!;
    }
    for (let j = 0; j < NFILT; j++) {
      let s = 0;
      const fb = filters[j]!;
      for (let i = 0; i <= NFFT / 2; i++) s += pspec[i]! * fb[i]!;
      logFb[j] = Math.log(s === 0 ? Number.EPSILON : s);
    }
    // DCT-II ortonormale (come scipy.fftpack.dct norm="ortho"), primi 13 coefficienti, lifter 22,
    // e il primo coefficiente sostituito dal log dell'energia del fotogramma.
    for (let c = 0; c < 13; c++) {
      let s = 0;
      for (let j = 0; j < NFILT; j++) s += logFb[j]! * Math.cos((Math.PI * c * (2 * j + 1)) / (2 * NFILT));
      s *= c === 0 ? Math.sqrt(1 / NFILT) : Math.sqrt(2 / NFILT);
      const lift = 1 + (22 / 2) * Math.sin((Math.PI * c) / 22);
      out[f * 13 + c] = c === 0 ? Math.log(energy === 0 ? Number.EPSILON : energy) : s * lift;
    }
  }
  return out;
}

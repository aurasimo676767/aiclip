import path from "node:path";
import * as ort from "onnxruntime-node";
import { runFfmpegBinary } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";

/**
 * Controllo sulla VOCE prima di togliere il proprietario dal pannello webcam.
 *
 * Il modello chi-parla (active-speaker.ts) guarda se una bocca si muove a tempo con la voce che si
 * sente. Sbaglia quando la voce non è di nessuna webcam ma qualcuno muove la bocca lo stesso: in
 * "Scam With Your Friends" la vittima è un personaggio del gioco con voce sintetica, e mentre
 * parlava lui Manuxo muoveva la bocca (ripeteva, rideva) e si prendeva il pannello (segnalato da
 * simo, 2026-10-25, clip "LA RAGNETTA PAZZERELLA NON LO CONVINCE").
 *
 * Qui i tratti della clip si raggruppano per VOCE (stessa voce = stesso gruppo, senza sapere di chi
 * è), e ogni gruppo si attribuisce alla webcam che il modello chi-parla indica per la maggior parte
 * dei suoi tratti. La voce del gioco ha tanti tratti in cui nessuna webcam parla, quindi non è di
 * nessuno: nei suoi tratti resta il proprietario. Si calcola solo se il modello vuole mostrare
 * qualcuno che non è il proprietario, e costa circa un secondo.
 *
 * Modello: wespeaker ResNet34 (VoxCeleb, ONNX da github.com/k2-fsa/sherpa-onnx), 256 numeri per
 * voce; ingresso fbank Kaldi a 80 bande come in wespeaker (finestra hamming, senza dither, media
 * tolta per banda), campioni nella scala int16.
 */

const MODEL_PATH = path.resolve(process.cwd(), "models", "wespeaker_en_voxceleb_resnet34_LM.onnx");
const RATE = 16000;
/** Somiglianza (coseno) sopra cui due tratti hanno la stessa voce. */
const SAME_VOICE_SIMILARITY = 0.5;
/**
 * Punteggio medio del modello chi-parla, su TUTTI i tratti di una voce, oltre cui la voce è di quella
 * webcam. La media e non il conto dei tratti vinti: sulla voce del gioco Manuxo vinceva 3 tratti su 6
 * (mentre ripeteva le battute) ma negli altri 3 era chiaramente zitto, media 0,35; Blur sulla sua
 * voce stava a 1,1.
 */
const VOICE_OWNER_MIN_MEAN = 0.5;
/** Ogni tratto si allarga di tanto per lato: 1,5 s di voce sono pochi per riconoscerla. */
const PAD_SECONDS = 0.35;

let session: Promise<ort.InferenceSession> | null = null;
function getSession(): Promise<ort.InferenceSession> {
  session ??= ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["cpu"], intraOpNumThreads: 4 });
  return session;
}

// --- fbank come torchaudio.compliance.kaldi.fbank(num_mel_bins=80, window_type="hamming", dither=0) ---
const FRAME = 400;
const SHIFT = 160;
const NFFT = 512;
const BINS = 80;
let melBank: Float64Array[] | null = null;
function getMelBank(): Float64Array[] {
  if (melBank) return melBank;
  const mel = (f: number) => 1127 * Math.log(1 + f / 700);
  const low = mel(20);
  const high = mel(RATE / 2);
  const delta = (high - low) / (BINS + 1);
  const binWidth = RATE / NFFT;
  melBank = [];
  for (let b = 0; b < BINS; b++) {
    const left = low + b * delta;
    const center = left + delta;
    const right = center + delta;
    const w = new Float64Array(NFFT / 2 + 1);
    for (let i = 0; i < NFFT / 2; i++) {
      const m = mel(i * binWidth);
      const up = (m - left) / (center - left);
      const down = (right - m) / (right - center);
      w[i] = Math.max(0, Math.min(up, down));
    }
    melBank.push(w);
  }
  return melBank;
}
const hamming = Float64Array.from({ length: FRAME }, (_, n) => 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (FRAME - 1)));

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
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
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

function fbank(samples: Int16Array, from: number, to: number): Float32Array | null {
  const n = to - from;
  if (n < FRAME) return null;
  const frames = 1 + Math.floor((n - FRAME) / SHIFT);
  const bank = getMelBank();
  const out = new Float32Array(frames * BINS);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  for (let f = 0; f < frames; f++) {
    const start = from + f * SHIFT;
    let mean = 0;
    for (let i = 0; i < FRAME; i++) mean += samples[start + i]!;
    mean /= FRAME;
    re.fill(0);
    im.fill(0);
    let prev = samples[start]! - mean;
    for (let i = 0; i < FRAME; i++) {
      const x = samples[start + i]! - mean;
      re[i] = (x - 0.97 * prev) * hamming[i]!;
      prev = x;
    }
    fft(re, im);
    for (let b = 0; b < BINS; b++) {
      const w = bank[b]!;
      let e = 0;
      for (let i = 0; i < NFFT / 2; i++) if (w[i]) e += (re[i]! * re[i]! + im[i]! * im[i]!) * w[i]!;
      out[f * BINS + b] = Math.log(Math.max(e, 1.1920929e-7));
    }
  }
  // Media tolta per banda (CMN), come wespeaker.
  for (let b = 0; b < BINS; b++) {
    let m = 0;
    for (let f = 0; f < frames; f++) m += out[f * BINS + b]!;
    m /= frames;
    for (let f = 0; f < frames; f++) out[f * BINS + b]! -= m;
  }
  return out;
}

async function embed(feats: Float32Array): Promise<Float32Array> {
  const s = await getSession();
  const frames = feats.length / BINS;
  const out = await s.run({ feats: new ort.Tensor("float32", feats, [1, frames, BINS]) });
  const v = Float32Array.from(out.embs!.data as Float32Array);
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const cosine = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

/** Raggruppamento agglomerativo a legame medio: si uniscono i due gruppi più simili finché sono sopra soglia. */
function clusterVoices(embs: Array<Float32Array | null>): number[] {
  const groups: number[][] = [];
  embs.forEach((e, i) => {
    if (e) groups.push([i]);
  });
  const sim = (g: number[], h: number[]) => {
    let s = 0;
    for (const i of g) for (const j of h) s += cosine(embs[i]!, embs[j]!);
    return s / (g.length * h.length);
  };
  for (;;) {
    let best = -Infinity;
    let pair: [number, number] | null = null;
    for (let a = 0; a < groups.length; a++)
      for (let b = a + 1; b < groups.length; b++) {
        const s = sim(groups[a]!, groups[b]!);
        if (s > best) {
          best = s;
          pair = [a, b];
        }
      }
    if (!pair || best < SAME_VOICE_SIMILARITY) break;
    groups[pair[0]]!.push(...groups[pair[1]]!);
    groups.splice(pair[1], 1);
  }
  const label = embs.map(() => -1);
  groups.forEach((g, k) => g.forEach((i) => (label[i] = k)));
  return label;
}

/**
 * Ritorna le scelte di `chosen` dove un passaggio a una webcam diversa dal proprietario resta solo
 * se la voce di quel tratto è attribuita a quella webcam; gli altri tornano al proprietario.
 * `means[i][k]`: punteggio medio del modello chi-parla della webcam k nel tratto i.
 */
export async function verifySwitchesByVoice(p: {
  videoPath: string;
  startSeconds: number;
  segments: Array<{ startSeconds: number; endSeconds: number }>;
  means: number[][];
  chosen: number[];
  owner: number;
}): Promise<number[]> {
  const duration = p.segments[p.segments.length - 1]!.endSeconds;
  const pcm = await runFfmpegBinary(["-ss", String(Math.max(0, p.startSeconds)), "-t", String(duration), "-i", p.videoPath, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"]);
  const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + Math.floor(pcm.length / 2) * 2));

  // Impronta della voce di ogni tratto in cui qualcuno parla davvero (c'è voce abbastanza forte).
  const embs: Array<Float32Array | null> = [];
  for (const seg of p.segments) {
    const from = Math.max(0, Math.floor((seg.startSeconds - PAD_SECONDS) * RATE));
    const to = Math.min(samples.length, Math.ceil((seg.endSeconds + PAD_SECONDS) * RATE));
    let energy = 0;
    for (let i = from; i < to; i++) energy += samples[i]! * samples[i]!;
    const rmsDb = 20 * Math.log10(Math.sqrt(energy / Math.max(1, to - from)) / 32768 + 1e-9);
    const feats = rmsDb > -45 ? fbank(samples, from, to) : null;
    embs.push(feats ? await embed(feats) : null);
  }
  const voice = clusterVoices(embs);

  // A chi appartiene ogni voce: la webcam col punteggio medio più alto sui suoi tratti, se abbastanza alto.
  const voiceOwner = new Map<number, number>();
  const voiceMeans = new Map<number, number[]>();
  for (const v of new Set(voice.filter((x) => x >= 0))) {
    const segs = voice.map((x, i) => (x === v ? i : -1)).filter((i) => i >= 0);
    const avg = p.means[0]!.map((_, k) => segs.reduce((sum, i) => sum + p.means[i]![k]!, 0) / segs.length);
    const top = avg.indexOf(Math.max(...avg));
    voiceMeans.set(v, avg);
    voiceOwner.set(v, avg[top]! >= VOICE_OWNER_MIN_MEAN ? top : -1);
  }

  const result = p.chosen.map((k, i) => (k === p.owner || voice[i]! < 0 || voiceOwner.get(voice[i]!) === k ? k : p.owner));
  logger.info("Controllo voce sui cambi di webcam", {
    voci: [...voiceOwner.entries()].map(([v, k]) => `voce${v}=${k < 0 ? "nessuna webcam" : `webcam ${k}`} (${voiceMeans.get(v)!.map((m) => m.toFixed(1)).join("/")})`).join(" "),
    tratti: p.segments.map((s, i) => `${s.startSeconds.toFixed(1)}:v${voice[i]}${p.chosen[i] !== result[i] ? `(${p.chosen[i]}→${result[i]})` : ""}`).join(" "),
  });
  return result;
}

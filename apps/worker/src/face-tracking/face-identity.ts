import fsp from "node:fs/promises";
import path from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { LONGFORM_STREAMER_ALIASES } from "@clipforge/shared";
import { readFaceLibrary, type LibraryFace } from "../lib/face-library.js";
import { runFfmpegBinary } from "../lib/ffmpeg.js";
import { logger } from "../lib/logger.js";
import { storageProvider } from "../lib/providers.js";
import { runYtDlp } from "../lib/yt-dlp.js";
import type { PeopleHint } from "./face-tracker.js";
import type { FaceBox } from "./onnx-face-detector.js";

/**
 * Chi è il PROPRIETARIO del canale tra le webcam di una clip, confrontando i volti con le foto
 * che simo ha etichettato nella pagina Facce. Serve solo a questo: nel pannello in alto va lui
 * quando nessun altro parla (regola di simo, 2026-10-25). simo ha dato l'ok esplicito a usare il
 * riconoscimento facciale per questo scopo (a settembre era escluso): i nomi vengono SOLO dalle
 * sue etichette, il modello dice soltanto "questa webcam somiglia a queste foto".
 *
 * Modelli OpenCV Zoo, in locale e gratis: YuNet (trova il volto e 5 punti: occhi, naso, angoli
 * della bocca; licenza MIT) e SFace (128 numeri per volto, confrontati col coseno; Apache 2.0).
 * Preprocessing identico a cv::FaceDetectorYN e cv::FaceRecognizerSF.
 */

const YUNET_PATH = path.resolve(process.cwd(), "models", "face_detection_yunet_2023mar.onnx");
const SFACE_PATH = path.resolve(process.cwd(), "models", "face_recognition_sface_2021dec.onnx");
const YUNET_SIZE = 640;
const YUNET_SCORE = 0.6;
/** Punti di arrivo dell'allineamento (112x112), quelli di cv::FaceRecognizerSF::alignCrop. */
const ALIGN_DST: Array<[number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];
const EMBEDDING_CACHE_DIR = path.resolve(process.cwd(), "tmp", "face-embeddings");
/** Foto della libreria usate come riferimento per persona: bastano poche, e scaricarle costa. */
const MAX_REFS = 8;
/**
 * Somiglianza minima (coseno) per dire "è lui", e distacco minimo dalla seconda persona più simile.
 * OpenCV indica 0,363 per foto buone; qui una parte è una webcam piccola e compressa e l'altra una
 * foto di copertina con espressioni esagerate. Misurato sul video di Blur con 4 webcam: la persona
 * giusta stava fra 0,54 e 0,72, la seconda più simile almeno 0,13 sotto.
 */
const IDENTITY_MIN_SIMILARITY = 0.35;
const IDENTITY_MARGIN = 0.06;

interface Landmarked {
  score: number;
  box: { x: number; y: number; width: number; height: number };
  points: Array<[number, number]>;
}

let yunet: Promise<ort.InferenceSession> | null = null;
let sface: Promise<ort.InferenceSession> | null = null;

/** Immagine BGR grezza (w*h*3). */
interface BgrImage {
  data: Buffer;
  width: number;
  height: number;
}

async function detectLandmarks(img: BgrImage): Promise<Landmarked[]> {
  yunet ??= ort.InferenceSession.create(YUNET_PATH);
  const session = await yunet;
  // Come FaceDetectorYN: immagine BGR 0-255 senza normalizzare, qui rimpicciolita (o ingrandita)
  // per stare nei 640x640 del modello e completata con nero in basso/a destra.
  const scale = Math.min(YUNET_SIZE / img.width, YUNET_SIZE / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const resized = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
    .resize(w, h, { fit: "fill", kernel: "cubic" })
    .raw()
    .toBuffer();
  const plane = YUNET_SIZE * YUNET_SIZE;
  const input = new Float32Array(3 * plane);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const d = y * YUNET_SIZE + x;
      input[d] = resized[s]!;
      input[plane + d] = resized[s + 1]!;
      input[2 * plane + d] = resized[s + 2]!;
    }
  const out = await session.run({ input: new ort.Tensor("float32", input, [1, 3, YUNET_SIZE, YUNET_SIZE]) });
  const found: Landmarked[] = [];
  for (const stride of [8, 16, 32]) {
    const cls = out[`cls_${stride}`]!.data as Float32Array;
    const obj = out[`obj_${stride}`]!.data as Float32Array;
    const bbox = out[`bbox_${stride}`]!.data as Float32Array;
    const kps = out[`kps_${stride}`]!.data as Float32Array;
    const cols = YUNET_SIZE / stride;
    for (let idx = 0; idx < cls.length; idx++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[idx]!)) * Math.min(1, Math.max(0, obj[idx]!)));
      if (score < YUNET_SCORE) continue;
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const cx = (c + bbox[idx * 4]!) * stride;
      const cy = (r + bbox[idx * 4 + 1]!) * stride;
      const bw = Math.exp(bbox[idx * 4 + 2]!) * stride;
      const bh = Math.exp(bbox[idx * 4 + 3]!) * stride;
      found.push({
        score,
        box: { x: (cx - bw / 2) / scale, y: (cy - bh / 2) / scale, width: bw / scale, height: bh / scale },
        points: Array.from({ length: 5 }, (_, n) => [((kps[idx * 10 + 2 * n]! + c) * stride) / scale, ((kps[idx * 10 + 2 * n + 1]! + r) * stride) / scale] as [number, number]),
      });
    }
  }
  // NMS: i rilevamenti sovrapposti dello stesso volto tengono il più sicuro.
  found.sort((a, b) => b.score - a.score);
  const kept: Landmarked[] = [];
  for (const f of found) if (!kept.some((k) => iou(k.box, f.box) > 0.3)) kept.push(f);
  return kept;
}

function iou(a: Landmarked["box"], b: Landmarked["box"]): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/** Volto allineato 112x112 come FaceRecognizerSF::alignCrop: similitudine ai minimi quadrati sui 5 punti, poi campionamento bilineare. */
function alignCrop(img: BgrImage, points: Array<[number, number]>): Float32Array {
  const n = points.length;
  const ms = points.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  const md = ALIGN_DST.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  let num1 = 0;
  let num2 = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const px = points[i]![0] - ms[0]!;
    const py = points[i]![1] - ms[1]!;
    const qx = ALIGN_DST[i]![0] - md[0]!;
    const qy = ALIGN_DST[i]![1] - md[1]!;
    num1 += px * qx + py * qy;
    num2 += px * qy - py * qx;
    den += px * px + py * py;
  }
  const a = num1 / den;
  const b = num2 / den;
  const tx = md[0]! - (a * ms[0]! - b * ms[1]!);
  const ty = md[1]! - (b * ms[0]! + a * ms[1]!);
  const det = a * a + b * b;
  // SFace vuole RGB 0-255 in NCHW (blobFromImage con swapRB).
  const plane = 112 * 112;
  const out = new Float32Array(3 * plane);
  for (let v = 0; v < 112; v++)
    for (let u = 0; u < 112; u++) {
      const dx = u - tx;
      const dy = v - ty;
      const sx = (a * dx + b * dy) / det;
      const sy = (-b * dx + a * dy) / det;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const px = (x: number, y: number) =>
          x < 0 || y < 0 || x >= img.width || y >= img.height ? 0 : img.data[(y * img.width + x) * 3 + ch]!;
        const val = px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) + px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy;
        out[(2 - ch) * plane + v * 112 + u] = val; // BGR -> RGB
      }
    }
  return out;
}

async function embed(aligned: Float32Array): Promise<Float32Array> {
  sface ??= ort.InferenceSession.create(SFACE_PATH);
  const session = await sface;
  const out = await session.run({ data: new ort.Tensor("float32", aligned, [1, 3, 112, 112]) });
  const v = Float32Array.from(out.fc1!.data as Float32Array);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const cosine = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

/** Impronta del volto più vicino a (cx, cy) nell'immagine, o del più sicuro se non indicato. */
async function embedFace(img: BgrImage, near?: { x: number; y: number }): Promise<Float32Array | null> {
  const faces = await detectLandmarks(img);
  if (faces.length === 0) return null;
  const pick = near
    ? faces.reduce((best, f) => {
        const d = (g: Landmarked) => Math.hypot(g.box.x + g.box.width / 2 - near.x, g.box.y + g.box.height / 2 - near.y);
        return d(f) < d(best) ? f : best;
      })
    : faces[0]!;
  return embed(alignCrop(img, pick.points));
}

export interface PersonReference {
  label: string;
  embeddings: Float32Array[];
}

/**
 * Quanto è girata la testa nella foto (0 = di fronte, ~0,5 = quasi di profilo): distanza del naso dal
 * punto fra gli occhi, in rapporto alla distanza fra gli occhi (YuNet: occhi, naso, angoli della
 * bocca). null se non c'è un volto. Serve a scegliere le foto di riferimento per le copertine.
 */
export async function faceTurn(imagePath: string): Promise<number | null> {
  const { data, info } = await sharp(imagePath).flatten({ background: "#808080" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bgr = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 3) {
    bgr[i] = data[i + 2]!;
    bgr[i + 1] = data[i + 1]!;
    bgr[i + 2] = data[i]!;
  }
  const face = (await detectLandmarks({ data: bgr, width: info.width, height: info.height })).sort((a, b) => b.box.width - a.box.width)[0];
  if (!face) return null;
  const [eyeA, eyeB, nose] = face.points as [[number, number], [number, number], [number, number]];
  const eyes = Math.hypot(eyeA[0] - eyeB[0], eyeA[1] - eyeB[1]);
  return eyes > 0 ? Math.abs(nose[0] - (eyeA[0] + eyeB[0]) / 2) / eyes : null;
}

async function embedLibraryFace(face: LibraryFace, workDir: string): Promise<Float32Array | null> {
  const cacheFile = path.join(EMBEDDING_CACHE_DIR, `${face.id}.json`);
  try {
    return Float32Array.from(JSON.parse(await fsp.readFile(cacheFile, "utf8")) as number[]);
  } catch {
    // non ancora calcolata
  }
  const local = path.join(workDir, `ref-${face.id}.png`);
  try {
    await storageProvider.downloadToFile(face.path, local);
    // Le foto sono scontornate (sfondo trasparente): si appoggiano su grigio, come le vede chi le guarda.
    const { data, info } = await sharp(local).flatten({ background: "#808080" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const bgr = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 3) {
      bgr[i] = data[i + 2]!;
      bgr[i + 1] = data[i + 1]!;
      bgr[i + 2] = data[i]!;
    }
    const e = await embedFace({ data: bgr, width: info.width, height: info.height });
    // Anche "nessun volto" si ricorda (lista vuota), per non riscaricare la foto a ogni render.
    await fsp.writeFile(cacheFile, JSON.stringify(e ? Array.from(e) : []));
    return e;
  } catch (err) {
    logger.warn("Foto della libreria non usabile come riferimento", { faceId: face.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    await fsp.rm(local, { force: true });
  }
}

/**
 * Impronte di TUTTE le persone etichettate nella libreria di `userId` (fino a MAX_REFS foto a
 * testa). Tutte e non solo il proprietario: confrontando una webcam con tutti si vede a chi
 * somiglia DI PIÙ. Contro il solo proprietario, sul video di Blur con 4 webcam, Blur e Manuxo
 * risultavano quasi uguali (0,42 contro 0,41); contro tutti, Manuxo somigliava molto di più a
 * Manuxo (0,72) e Blur a Blur (0,54). Ogni foto si calcola una volta sola e resta in
 * tmp/face-embeddings (le foto non cambiano: il nome del file è il loro id).
 */
export async function loadPeopleReferences(userId: string, workDir: string): Promise<PersonReference[]> {
  const library = await readFaceLibrary(userId, workDir);
  await fsp.mkdir(EMBEDDING_CACHE_DIR, { recursive: true });
  const byLabel = new Map<string, LibraryFace[]>();
  for (const f of library.faces) {
    if (f.status !== "labeled" || !f.label || f.tags?.includes("meme")) continue;
    const list = byLabel.get(f.label) ?? [];
    if (list.length < MAX_REFS) list.push(f);
    byLabel.set(f.label, list);
  }
  const people: PersonReference[] = [];
  for (const [label, faces] of byLabel) {
    const embeddings: Float32Array[] = [];
    for (const f of faces) {
      const e = await embedLibraryFace(f, workDir);
      if (e && e.length) embeddings.push(e);
    }
    if (embeddings.length) people.push({ label, embeddings });
  }
  return people;
}

/**
 * Impronte di ogni webcam in alcuni fotogrammi della clip (più d'uno: in uno la testa può essere
 * girata). Il volto si cerca in un ritaglio attorno alla webcam, ingrandito: YuNet vuole volti non
 * troppo piccoli e le webcam di un gruppo sono spesso di 60-100 pixel.
 */
async function embedWebcams(videoPath: string, times: number[][], faces: FaceBox[], sourceWidth: number, sourceHeight: number): Promise<Float32Array[][]> {
  const OUT = 320;
  const result: Float32Array[][] = [];
  for (const [i, f] of faces.entries()) {
    const side = Math.min(sourceWidth, sourceHeight, Math.round(Math.max(f.width, f.height) * 2.5));
    const x = Math.max(0, Math.min(sourceWidth - side, Math.round(f.x + f.width / 2 - side / 2)));
    const y = Math.max(0, Math.min(sourceHeight - side, Math.round(f.y + f.height / 2 - side / 2)));
    const list: Float32Array[] = [];
    for (const t of times[i] ?? []) {
      try {
        const data = await runFfmpegBinary([
          "-ss",
          String(Math.max(0, t)),
          "-i",
          videoPath,
          "-frames:v",
          "1",
          "-vf",
          `crop=${side}:${side}:${x}:${y},scale=${OUT}:${OUT}:flags=lanczos`,
          "-pix_fmt",
          "bgr24",
          "-f",
          "rawvideo",
          "-",
        ]);
        const e = await embedFace({ data, width: OUT, height: OUT }, { x: OUT / 2, y: OUT / 2 });
        if (e) list.push(e);
      } catch {
        // fotogramma non leggibile: si prova il successivo
      }
    }
    result.push(list);
  }
  return result;
}

export interface WebcamIdentity {
  /** Persona a cui la webcam somiglia di più, o null se non abbastanza / troppo in bilico. */
  label: string | null;
  similarity: number;
}

/**
 * A chi somiglia ogni webcam tra le persone etichettate. Somiglianza con una persona = media delle
 * sue 3 foto più somiglianti (una foto sola può ingannare), il valore migliore tra i fotogrammi.
 * `times[k]`: istanti (assoluti) in cui guardare la webcam k — quelli in cui il suo volto c'era
 * davvero: in un primo piano del montatore il ritaglio cadrebbe sulla faccia di un altro.
 */
export async function identifyWebcams(
  videoPath: string,
  times: number[][],
  faces: FaceBox[],
  sourceWidth: number,
  sourceHeight: number,
  people: PersonReference[],
): Promise<WebcamIdentity[]> {
  const webcams = await embedWebcams(videoPath, times, faces, sourceWidth, sourceHeight);
  return webcams.map((frames) => {
    const scores = people.map((p) => {
      let best = -1;
      for (const e of frames) {
        const top = p.embeddings.map((r) => cosine(e, r)).sort((a, b) => b - a).slice(0, 3);
        best = Math.max(best, top.reduce((a, b) => a + b, 0) / top.length);
      }
      return { label: p.label, score: best };
    });
    scores.sort((a, b) => b.score - a.score);
    const [first, second] = scores;
    if (!first || first.score < IDENTITY_MIN_SIMILARITY || (second && first.score - second.score < IDENTITY_MARGIN)) {
      return { label: null, similarity: first?.score ?? -1 };
    }
    return { label: first.label, similarity: first.score };
  });
}

const channelCache = new Map<string, string | null>();

/**
 * Nome del canale da cui viene il video: per Twitch c'è già (streamer_login), per YouTube si chiede
 * a yt-dlp (una volta per video, senza scaricare niente).
 */
async function channelNameOf(video: { id: string; source_url: string | null; streamer_login?: string | null; streamer_name?: string | null }): Promise<string | null> {
  if (video.streamer_login || video.streamer_name) return video.streamer_login ?? video.streamer_name ?? null;
  if (!video.source_url || !/youtu\.?be/.test(video.source_url)) return null;
  if (channelCache.has(video.id)) return channelCache.get(video.id)!;
  let name: string | null = null;
  try {
    const { stdout } = await runYtDlp(["--skip-download", "--no-playlist", "--print", "%(channel)s|%(uploader_id)s", video.source_url]);
    name = stdout.trim().split("\n").pop() ?? null;
  } catch (err) {
    logger.warn("Nome del canale YouTube non disponibile", { videoId: video.id, error: err instanceof Error ? err.message : String(err) });
  }
  channelCache.set(video.id, name);
  return name;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Etichetta della libreria (es. "BLUR") del proprietario del canale del video: dagli alias noti
 * (tumblurr → BLUR) o, se no, l'etichetta contenuta nel nome del canale ("Blur Indietro" → BLUR).
 */
export async function ownerLabelForVideo(
  video: { id: string; source_url: string | null; streamer_login?: string | null; streamer_name?: string | null },
  labels: string[],
): Promise<string | null> {
  const channel = await channelNameOf(video);
  if (!channel) return null;
  // "Blur Indietro|@blurindietro": si prova ogni pezzo (nome e handle) sugli alias noti.
  for (const part of channel.split("|")) {
    const alias = LONGFORM_STREAMER_ALIASES[part.trim().replace(/^@/, "").toLowerCase()];
    if (alias && labels.includes(alias)) return alias;
  }
  const norm = normalize(channel);
  const matches = labels.filter((l) => normalize(l).length >= 3 && norm.includes(normalize(l))).sort((a, b) => b.length - a.length);
  return matches[0] ?? null;
}

const peopleCache = new Map<string, { at: number; people: PersonReference[] }>();
/** Le impronte della libreria si rileggono al massimo ogni 10 minuti: tra un render e l'altro simo raramente etichetta facce nuove. */
const PEOPLE_CACHE_MS = 10 * 60 * 1000;

/**
 * Persone etichettate e proprietario del canale del video, per il pannello webcam degli Shorts.
 * undefined se la libreria è vuota o qualcosa va storto: allora il proprietario è chi parla di più.
 */
export async function peopleHintForVideo(
  video: { id: string; source_url: string | null; streamer_login?: string | null; streamer_name?: string | null },
  userId: string,
  workDir: string,
): Promise<PeopleHint | undefined> {
  try {
    const cached = peopleCache.get(userId);
    const people = cached && Date.now() - cached.at < PEOPLE_CACHE_MS ? cached.people : await loadPeopleReferences(userId, workDir);
    peopleCache.set(userId, { at: cached && Date.now() - cached.at < PEOPLE_CACHE_MS ? cached.at : Date.now(), people });
    if (!people.length) return undefined;
    const ownerLabel = await ownerLabelForVideo(video, people.map((p) => p.label));
    return { references: people, ownerLabel };
  } catch (err) {
    logger.warn("Persone della libreria non disponibili per il pannello webcam", { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

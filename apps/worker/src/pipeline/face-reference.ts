import path from "node:path";
import sharp from "sharp";
import type { FaceLibraryIndex, LibraryFace } from "../lib/face-library.js";
import { detectFaces } from "../face-tracking/onnx-face-detector.js";
import { DETECTOR_INPUT_HEIGHT, DETECTOR_INPUT_WIDTH } from "../face-tracking/frame-extractor.js";
import { downloadFaces, PERSON_STYLE } from "./cover-builder.js";

/**
 * Foto di riferimento per far disegnare a GPT Image le facce GIUSTE (simo, 2026-09-30: "sminchia
 * troppo le persone, blur occhi strambi, marza lo fa sempre ciccione, manuxo sempre uno appena uscito
 * dai balletti di tiktok, pesh ancora ancora lo fa simile"; "le facce devono farle l'AI, ma fatte bene").
 *
 * Misurato sulla libreria: le foto di Pesh (l'unico venuto somigliante) sono grandi, nitide e di
 * fronte; quelle di Manuxo sono inquadrature larghe della webcam, con la faccia piccola, spesso di
 * lato e ingrandita fino a sfocarsi; fra quelle di Marza ci sono disegni, filtri e urla. Con poca
 * faccia a disposizione il modello se la inventa.
 *
 * Qui si passa al modello un primo piano STRETTO della testa (la faccia riempie l'immagine), scelto
 * fra le foto con la faccia più grande e nitida e l'espressione meno deformata. Rileva solo dove sta
 * un volto (non chi è): i nomi restano quelli dati da simo.
 */

const CROP_SIZE = 768;
/** Quanto allargare il riquadro del volto per tenere capelli, barba, occhiali e cuffie. */
const HEAD_EXPAND = 2.0;
/** Candidate scaricate per persona: la libreria ne ha al massimo ~25. */
const MAX_CANDIDATES = 20;

export interface HeadCrop {
  face: LibraryFace;
  path: string;
  /** Larghezza del volto nella foto originale, in pixel. */
  faceWidth: number;
  sharpness: number;
  score: number;
}

/** Varianza del laplaciano: più alta = più nitida. */
async function sharpnessOf(image: Buffer): Promise<number> {
  const { data, info } = await sharp(image).resize({ width: 256 }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < info.width - 1; x++) {
      const i = y * info.width + x;
      const l = 4 * data[i]! - data[i - 1]! - data[i + 1]! - data[i - info.width]! - data[i + info.width]!;
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  return n ? sum2 / n - (sum / n) ** 2 : 0;
}

/** Primo piano quadrato della testa da un ritaglio della libreria; null se non si trova un volto. */
export async function headCrop(pngPath: string, outPath: string): Promise<{ faceWidth: number; sharpness: number } | null> {
  const flat = await sharp(pngPath).flatten({ background: "#9a9a9a" }).toBuffer();
  const meta = await sharp(flat).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return null;
  const rgb = await sharp(flat).resize(DETECTOR_INPUT_WIDTH, DETECTOR_INPUT_HEIGHT, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const bgr = Buffer.alloc(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    bgr[i] = rgb[i + 2]!;
    bgr[i + 1] = rgb[i + 1]!;
    bgr[i + 2] = rgb[i]!;
  }
  const boxes = await detectFaces(bgr, w, h);
  const box = boxes.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!box) return null;

  const side = Math.min(Math.round(Math.max(box.width, box.height) * HEAD_EXPAND), w, h);
  const cx = box.x + box.width / 2;
  // Un po' più in alto del centro del volto: i capelli e il cappello contano più del collo.
  const cy = box.y + box.height * 0.42;
  const left = Math.round(Math.min(Math.max(0, cx - side / 2), w - side));
  const top = Math.round(Math.min(Math.max(0, cy - side / 2), h - side));
  const crop = await sharp(flat).extract({ left, top, width: side, height: side }).toBuffer();
  const sharpness = await sharpnessOf(crop);
  // Mai ingrandire più di 2,5 volte: oltre, l'upscaling inventa dettagli quanto il modello.
  const size = Math.min(CROP_SIZE, Math.round(side * 2.5));
  await sharp(crop).resize(size, size, { kernel: "lanczos3" }).jpeg({ quality: 94 }).toFile(outPath);
  return { faceWidth: box.width, sharpness };
}

/**
 * I primi piani migliori di una persona per il modello: faccia grande e nitida, espressione non
 * esagerata (urla e smorfie deformano la faccia e il modello le prende per lineamenti), niente foto
 * "meme". Se la persona ha uno stile fisso (Blur col Red Bull) almeno una foto lo mostra.
 */
export async function bestHeadCrops(library: FaceLibraryIndex, label: string, n: number, dir: string): Promise<HeadCrop[]> {
  const tag = PERSON_STYLE[label]?.tag;
  const pool = library.faces
    .filter((f) => f.status === "labeled" && f.label === label && !f.tags?.includes("meme"))
    // Prima quelle confermate da simo come riferimento, poi le meno esagerate.
    .sort((a, b) => Number(Boolean(b.tags?.includes("ref"))) - Number(Boolean(a.tags?.includes("ref"))) || a.intensity - b.intensity)
    .slice(0, MAX_CANDIDATES);
  const files = await downloadFaces(pool, dir);
  const crops: HeadCrop[] = [];
  for (let i = 0; i < pool.length; i++) {
    const face = pool[i]!;
    const out = path.join(dir, `ref-${face.id}.jpg`);
    const measured = await headCrop(files[i]!, out).catch(() => null);
    if (!measured) continue;
    const score =
      (face.tags?.includes("ref") ? 3 : 0) + // scelte da simo come riferimento: vincono sempre
      Math.min(measured.faceWidth, 260) / 260 + // faccia grande = più dettagli veri
      Math.min(measured.sharpness, 1500) / 1500 - // nitida
      (face.intensity >= 4 ? 0.6 : face.intensity === 3 ? 0.2 : 0); // smorfie forti deformano
    crops.push({ face, path: out, faceWidth: measured.faceWidth, sharpness: measured.sharpness, score });
  }
  crops.sort((a, b) => b.score - a.score);
  const picked = crops.slice(0, n);
  if (tag && !picked.some((c) => c.face.tags?.includes(tag))) {
    const styled = crops.find((c) => c.face.tags?.includes(tag));
    if (styled) picked.splice(Math.max(0, picked.length - 1), 1, styled);
  }
  return picked;
}

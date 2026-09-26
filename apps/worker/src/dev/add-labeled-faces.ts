import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { removeBackground } from "@imgly/background-removal-node";
import { detectFaces } from "../face-tracking/onnx-face-detector.js";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";
import { readFaceLibrary, writeFaceLibrary, faceLibraryRoot, isBustCutout, type LibraryFace } from "../lib/face-library.js";
import { rateFaceImages } from "../providers/ai/rate-faces.js";
import { env } from "../env.js";

/**
 * Aggiunge alla libreria delle copertine le foto di una persona mandate da simo, GIÀ col nome che
 * ha scritto lui (niente riconoscimento facciale): trova il volto più grande di ogni foto, ritaglia
 * il busto, scontorna, fa giudicare a Haiku pulizia ed espressione (MAI chi è) e carica come
 * faccia "labeled". I ritagli giudicati sporchi si scartano. A pagamento: ~0,005 $ ogni 8 foto.
 * Uso: tsx src/dev/add-labeled-faces.ts [--cutout] <NOME> <cartella di lavoro> <foto> [foto...]
 * --cutout: le immagini sono GIÀ ritagli scontornati (PNG): si saltano rilevamento, ritaglio e scontorno.
 */
const cutoutMode = process.argv.includes("--cutout");
const [labelArg, workArg, ...photos] = process.argv.slice(2).filter((a) => a !== "--cutout");
if (!labelArg || !workArg || photos.length === 0) throw new Error("Uso: tsx src/dev/add-labeled-faces.ts <NOME> <cartella> <foto>...");
const label = labelArg.toUpperCase();
const work = path.resolve(workArg);
await fsp.mkdir(path.join(work, "faces"), { recursive: true });

const { data: profile } = await supabase.from("profiles").select("id").limit(1).single();
if (!profile) throw new Error("Nessun profilo utente");
const library = await readFaceLibrary(profile.id, work);

let added = 0;
for (const photo of photos) {
  let cut: Buffer;
  if (cutoutMode) {
    cut = await sharp(photo).trim().resize({ height: 800, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  } else {
  const img = sharp(photo).rotate();
  const { width, height } = await img.metadata();
  if (!width || !height) continue;
  const rgb = await img.clone().resize(320, 240, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const bgr = Buffer.alloc(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    bgr[i] = rgb[i + 2]!;
    bgr[i + 1] = rgb[i + 1]!;
    bgr[i + 2] = rgb[i]!;
  }
  const faces = await detectFaces(bgr, width, height);
  const f = faces.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!f) {
    console.warn(`nessun volto trovato in ${photo}`);
    continue;
  }
  // Busto: testa, spalle e un po' di petto, come nelle copertine.
  const left = Math.max(0, Math.round(f.x - f.width * 1.1));
  const top = Math.max(0, Math.round(f.y - f.height * 0.6));
  const right = Math.min(width, Math.round(f.x + f.width * 2.1));
  const bottom = Math.min(height, Math.round(f.y + f.height * 2.8));
  // Risoluzione più alta PRIMA dello scontorno (richiesta di simo): ridimensionamento classico
  // lanczos, niente AI che reinventa i dettagli, così il viso resta identico; in più lo scontorno
  // lavora su più pixel e i bordi vengono più puliti.
  const cropH = bottom - top;
  const targetH = cropH < 1000 ? Math.min(1600, Math.max(1000, cropH * 2)) : cropH;
  const crop = await img
    .clone()
    .extract({ left, top, width: right - left, height: cropH })
    .resize({ height: targetH, kernel: "lanczos3" })
    .sharpen({ sigma: 0.8, m1: 0.5, m2: 1.5 })
    .png()
    .toBuffer();
  const blob = await removeBackground(new Blob([crop], { type: "image/png" }));
  cut = await sharp(Buffer.from(await blob.arrayBuffer())).trim().resize({ height: 800, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  }

  const id = crypto.randomUUID();
  const local = path.join(work, "faces", `${id}.png`);
  await fsp.writeFile(local, cut);
  const { ratings } = await rateFaceImages([local], { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL_CHEAP });
  const rating = ratings.get(local);
  if (rating && !rating.usable) {
    console.warn(`scartata ${path.basename(photo)}: ${rating.issues.join("; ")}`);
    continue;
  }
  const key = `${faceLibraryRoot(profile.id)}/${id}.png`;
  await storageProvider.uploadFile(local, key, "image/png");
  const face: LibraryFace & { sourceFile: string } = {
    id,
    path: key,
    expression: rating?.expression ?? "neutra",
    intensity: rating?.intensity ?? 3,
    sourceVideoId: "foto-di-simo",
    label,
    status: "labeled",
    bust: await isBustCutout(cut),
    sourceFile: path.basename(photo),
  };
  library.faces.push(face);
  added++;
}
await writeFaceLibrary(profile.id, library, work);
console.log(`aggiunte ${added} facce di ${label} (ritagli in ${path.join(work, "faces")})`);

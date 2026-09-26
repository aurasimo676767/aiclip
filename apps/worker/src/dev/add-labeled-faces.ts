import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { cutBustFromPhoto } from "../render/bust-cutout.js";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";
import { readFaceLibrary, writeFaceLibrary, faceLibraryRoot, isBustCutout, measureCutout, type LibraryFace } from "../lib/face-library.js";
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
    const bust = await cutBustFromPhoto(photo);
    if (!bust) {
      console.warn(`nessun volto trovato in ${photo}`);
      continue;
    }
    cut = bust;
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
    ...(await measureCutout(cut).then((s) => ({ bothSidesCut: s.cuts.left && s.cuts.right, baseCover: Number(s.baseCover.toFixed(2)) }))),
    sourceFile: path.basename(photo),
  };
  library.faces.push(face);
  added++;
}
await writeFaceLibrary(profile.id, library, work);
console.log(`aggiunte ${added} facce di ${label} (ritagli in ${path.join(work, "faces")})`);

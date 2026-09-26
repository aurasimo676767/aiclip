import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";
import { readFaceLibrary, writeFaceLibrary, faceLibraryRoot, isBustCutout, type LibraryFace } from "../lib/face-library.js";

/**
 * Carica nella libreria delle facce (R2) i ritagli giudicati utilizzabili da rate-faces.ts, come
 * "candidate" senza nome: il nome lo mette simo dalla pagina Facce del sito. Non tocca le facce già
 * caricate (né i loro nomi): una faccia già presente (stesso file d'origine) si salta.
 * Uso: tsx src/dev/upload-face-library.ts <cartella harvest> [intensità minima=1]
 */
const dir = process.argv[2]!;
const minIntensity = Number(process.argv[3] ?? "1");
const { data: profile } = await supabase.from("profiles").select("id").limit(1).single();
if (!profile) throw new Error("Nessun profilo utente");
const userId = profile.id;

const ratings = JSON.parse(await fsp.readFile(path.join(dir, "rating.json"), "utf8")) as Record<string, { usable: boolean; expression: string; intensity: number }>;
const work = path.join(dir, "upload-tmp");
await fsp.mkdir(work, { recursive: true });
const library = await readFaceLibrary(userId, work);
const knownFiles = new Set(library.faces.map((f) => (f as LibraryFace & { sourceFile?: string }).sourceFile));

let added = 0;
for (const [file, r] of Object.entries(ratings)) {
  if (!r.usable || r.intensity < minIntensity || knownFiles.has(file)) continue;
  const id = crypto.randomUUID();
  const local = path.join(work, `${id}.png`);
  // Al massimo 800px di altezza: basta per una copertina 1280x720 e tiene piccolo il file.
  await sharp(path.join(dir, "faces", file)).resize({ height: 800, withoutEnlargement: true }).png({ compressionLevel: 9 }).toFile(local);
  const key = `${faceLibraryRoot(userId)}/${id}.png`;
  await storageProvider.uploadFile(local, key, "image/png");
  await fsp.rm(local, { force: true });
  const face: LibraryFace & { sourceFile: string } = {
    id,
    path: key,
    expression: r.expression,
    intensity: r.intensity,
    sourceVideoId: file.replace(/-\d+\.png$/, ""),
    label: null,
    status: "candidate",
    bust: await isBustCutout(await fsp.readFile(path.join(dir, "faces", file))),
    sourceFile: file,
  };
  library.faces.push(face);
  added++;
}
await writeFaceLibrary(userId, library, work);
console.log(`caricate ${added} facce nuove, totale libreria ${library.faces.length}`);

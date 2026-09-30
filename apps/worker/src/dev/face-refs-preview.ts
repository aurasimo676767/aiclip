import "dotenv/config";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { supabase } from "../lib/supabase.js";
import { readFaceLibrary } from "../lib/face-library.js";
import { bestHeadCrops } from "../pipeline/face-reference.js";

/**
 * Mostra i primi piani che verrebbero dati a GPT Image come riferimento per ogni persona (gratis,
 * nessuna chiamata AI). Uso: tsx src/dev/face-refs-preview.ts <cartella> NOME [NOME...]
 */
const [dir, ...names] = process.argv.slice(2);
const { data: project } = await supabase.from("projects").select("user_id").limit(1).single();
const lib = await readFaceLibrary(project!.user_id, os.tmpdir());
for (const name of names) {
  const work = path.join(dir!, `refs-${name}`);
  fs.mkdirSync(work, { recursive: true });
  const crops = await bestHeadCrops(lib, name, 4, work);
  console.log(name, crops.map((c) => `${c.face.expression}/int${c.face.intensity} volto ${Math.round(c.faceWidth)}px nitid ${Math.round(c.sharpness)}`).join(" | "));
  const cell = 300;
  const tiles = await Promise.all(crops.map(async (c) => sharp(c.path).resize(cell, cell).toBuffer()));
  await sharp({ create: { width: cell * Math.max(1, tiles.length), height: cell, channels: 3, background: "#222" } })
    .composite(tiles.map((t, i) => ({ input: t, left: i * cell, top: 0 })))
    .jpeg({ quality: 88 })
    .toFile(path.join(dir!, `refs-${name}.jpg`));
}

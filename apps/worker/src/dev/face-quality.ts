import "dotenv/config";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import { supabase } from "../lib/supabase.js";
import { readFaceLibrary } from "../lib/face-library.js";
import { storageProvider } from "../lib/providers.js";

/**
 * Qualità delle foto della libreria facce come riferimento per l'AI: dimensioni e nitidezza
 * (varianza del laplaciano sulla parte alta, dove sta la faccia). Uso: tsx src/dev/face-quality.ts <cartella> [NOME...]
 */
const [dir, ...names] = process.argv.slice(2);
const { data: project } = await supabase.from("projects").select("user_id").limit(1).single();
const lib = await readFaceLibrary(project!.user_id, os.tmpdir());
const rows: Record<string, unknown>[] = [];
for (const f of lib.faces) {
  if (f.status !== "labeled" || !f.label || (names.length && !names.includes(f.label))) continue;
  const local = path.join(dir!, `${f.label}-${f.id}.png`);
  if (!fs.existsSync(local)) await storageProvider.downloadToFile(f.path, local);
  const meta = await sharp(local).metadata();
  const w = meta.width ?? 0, h = meta.height ?? 0;
  // Parte alta (testa), in grigio, laplaciano 3x3
  const top = await sharp(local).flatten({ background: "#808080" }).extract({ left: 0, top: 0, width: w, height: Math.max(1, Math.round(h * 0.55)) }).resize({ width: 256 }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = top;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < info.height - 1; y++) for (let x = 1; x < info.width - 1; x++) {
    const i = y * info.width + x;
    const l = 4 * data[i]! - data[i - 1]! - data[i + 1]! - data[i - info.width]! - data[i + info.width]!;
    sum += l; sum2 += l * l; n++;
  }
  const sharpness = sum2 / n - (sum / n) ** 2;
  rows.push({ label: f.label, id: f.id, w, h, sharpness: Math.round(sharpness), intensity: f.intensity, expression: f.expression, tags: f.tags ?? [], bust: f.bust, file: local });
}
rows.sort((a, b) => String(a.label).localeCompare(String(b.label)) || (b.sharpness as number) - (a.sharpness as number));
fs.writeFileSync(path.join(dir!, "quality.json"), JSON.stringify(rows, null, 1));
for (const r of rows) console.log(String(r.label).padEnd(8), `${r.w}x${r.h}`.padEnd(10), "nitid", String(r.sharpness).padStart(5), "int", r.intensity, String(r.expression).slice(0, 30), (r.tags as string[]).join(","));

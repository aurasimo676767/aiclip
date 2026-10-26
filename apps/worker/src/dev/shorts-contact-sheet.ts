import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";

/**
 * Fogli di controllo degli Shorts renderizzati di un video (gratis): per ogni clip una riga di N
 * fotogrammi equidistanti letti direttamente da R2 (senza scaricare il video intero), 4 clip per
 * immagine. Uso: tsx src/dev/shorts-contact-sheet.ts <videoId> <cartellaOut> [fotogrammi=8]
 */
const [videoId, outDir, countArg = "8"] = process.argv.slice(2);
const count = Number(countArg);
fs.mkdirSync(outDir!, { recursive: true });
const { data: clips } = await supabase
  .from("clips")
  .select("id, title, start_time, output_video_path, format")
  .eq("video_id", videoId!)
  .eq("status", "COMPLETED")
  .order("start_time", { ascending: true });
const rows: string[] = [];
for (const [i, clip] of (clips ?? []).filter((c) => c.format !== "longform" && c.output_video_path).entries()) {
  const url = await storageProvider.getSignedUrl(clip.output_video_path!, 3600);
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", url]).toString().trim());
  const row = path.join(outDir!, `row-${String(i + 1).padStart(2, "0")}.jpg`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    url,
    "-vf",
    `fps=${(count / duration).toFixed(5)},scale=180:320,tile=${count}x1:padding=3:color=white`,
    "-frames:v",
    "1",
    row,
  ]);
  rows.push(row);
  console.log(`${i + 1}. ${clip.title} (${duration.toFixed(1)}s, inizio ${Math.round(clip.start_time)}s) ${clip.id}`);
}
for (let s = 0; s < rows.length; s += 4) {
  const part = rows.slice(s, s + 4);
  const out = path.join(outDir!, `sheet-${s / 4 + 1}.jpg`);
  execFileSync("ffmpeg", ["-v", "error", "-y", ...part.flatMap((r) => ["-i", r]), "-filter_complex", part.length > 1 ? `vstack=inputs=${part.length}` : "null", out]);
  console.log("foglio", out);
}

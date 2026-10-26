import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";

/**
 * Rifà un render long-form morto a metà usando il comando ffmpeg già scritto nel log e il filtro
 * rimasto nella cartella del job: niente AI, niente spesa (2026-10-25, Affari Tuoi: il worker è morto
 * per memoria con 49 ingressi dello stesso VOD, ognuno con un decoder a 20 thread). Ogni ingresso
 * oltre il primo legge pochi secondi, quindi gli basta un thread. Poi carica video e anteprima e
 * chiude clip e render job come farebbe process-render-job.ts.
 * Uso: tsx src/dev/finish-render-from-log.ts <AAAA-MM-GG> <render_job_id>
 */
const [day, jobId] = process.argv.slice(2);
if (!day || !jobId) throw new Error("Uso: tsx src/dev/finish-render-from-log.ts <AAAA-MM-GG> <render_job_id>");

const jobDir = path.join("tmp", `render-${jobId}`);
const line = fs
  .readFileSync(path.join("tmp", "logs", `worker-${day}.log`), "utf8")
  .split("\n")
  .filter((l) => l.includes('"args":"') && l.includes(`render-${jobId}`) && l.includes("edit-filter.txt"))
  .pop();
if (!line) throw new Error("Comando ffmpeg del job non trovato nel log");
const args = (JSON.parse(line.slice(line.indexOf("{"))) as { args: string }).args.split(" ");

let inputs = 0;
const fixed: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-i") {
    inputs++;
    // Il primo ingresso è il pezzo intero; gli altri (intro, zoom, scritta, suono) durano pochi secondi.
    if (inputs > 1) {
      let at = fixed.length;
      while (at >= 2 && ["-ss", "-t", "-loop"].includes(fixed[at - 2]!)) at -= 2;
      fixed.splice(at, 0, "-threads", "1");
    }
  }
  fixed.push(args[i]!);
}
console.log(`Ingressi: ${inputs}, uscita: ${fixed[fixed.length - 1]}`);

const output = fixed[fixed.length - 1]!;
const code = await new Promise<number>((resolve) => {
  const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-stats", ...fixed], { stdio: ["ignore", "inherit", "inherit"] });
  ff.on("close", (c) => resolve(c ?? 1));
});
if (code !== 0 || !fs.existsSync(output) || fs.statSync(output).size < 1_000_000) throw new Error(`ffmpeg fallito (codice ${code})`);

const { data: job } = await supabase.from("render_jobs").select("clip_id").eq("id", jobId).single();
const { data: clip } = await supabase.from("clips").select("id, project_id").eq("id", job!.clip_id).single();
const thumbnail = path.join(jobDir, "thumbnail.jpg");
await new Promise<void>((resolve, reject) =>
  spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", output, "-ss", "1", "-frames:v", "1", thumbnail]).on("close", (c) => (c === 0 ? resolve() : reject(new Error("anteprima fallita")))),
);
const clipPath = `clips/${clip!.project_id}/${clip!.id}.mp4`;
const thumbPath = `thumbnails/${clip!.project_id}/${clip!.id}.jpg`;
await storageProvider.uploadFile(output, clipPath, "video/mp4");
await storageProvider.uploadFile(thumbnail, thumbPath, "image/jpeg");
await supabase.from("clips").update({ status: "COMPLETED", output_video_path: clipPath, thumbnail_path: thumbPath, error_message: null }).eq("id", clip!.id);
await supabase.from("render_jobs").update({ status: "COMPLETED", stage: "done", progress: 100, completed_at: new Date().toISOString() }).eq("id", jobId);
console.log(`Fatto: ${clipPath} (${(fs.statSync(output).size / 1e9).toFixed(2)} GB)`);
fs.rmSync(jobDir, { recursive: true, force: true });

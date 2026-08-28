import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import path from "node:path";
import { runFfmpeg, probeVideo } from "../lib/ffmpeg.js";

const execFileAsync = promisify(execFile);

const url = process.argv[2];
const outDir = process.argv[3] ?? "tmp/frame-extract";
const count = Number(process.argv[4] ?? 6);
if (!url) {
  console.error("Uso: tsx src/dev/extract-frames-from-url.ts <url-youtube> [cartella-output] [numero-fotogrammi]");
  process.exit(1);
}

await fsp.mkdir(outDir, { recursive: true });
const videoPath = path.join(outDir, "source.mp4");

console.log("Scarico...");
await execFileAsync("yt-dlp", ["-o", videoPath, url]);

// yt-dlp a volte aggiunge un'estensione diversa da .mp4 a seconda del formato scelto — la troviamo.
const files = await fsp.readdir(outDir);
const downloaded = files.find((f) => f.startsWith("source.mp4"));
if (!downloaded) throw new Error("File scaricato non trovato");
const realPath = path.join(outDir, downloaded);

const probe = await probeVideo(realPath);
console.log(`Durata: ${probe.durationSeconds.toFixed(1)}s, ${probe.width}x${probe.height}`);

for (let i = 1; i <= count; i++) {
  const t = (probe.durationSeconds * i) / (count + 1);
  const framePath = path.join(outDir, `full-${Math.round(t)}.jpg`);
  await runFfmpeg(["-y", "-ss", String(t), "-i", realPath, "-frames:v", "1", "-q:v", "2", framePath]);
}
console.log("Fotogrammi estratti in", outDir);

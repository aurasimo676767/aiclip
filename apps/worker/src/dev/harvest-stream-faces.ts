import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { detectFaces } from "../face-tracking/onnx-face-detector.js";

const run = promisify(execFile);

/**
 * Raccoglie primi piani GRANDI dalle live Twitch di un canale (momenti con la webcam a tutto
 * schermo), come foto di riferimento per le copertine (simo, 2026-09-30: "diamogli più foto per ogni
 * streamer, prendi foto di tutti nelle stream, possibilmente a full schermo"). Scarica solo singoli
 * fotogrammi dal flusso HLS, non la live intera. NON decide chi è: i nomi li conferma simo dal foglio.
 * Gratis. Uso: tsx src/dev/harvest-stream-faces.ts <cartella> <canale> [live=3] [ogni_secondi=240]
 */
const [outDir, channel, vodsArg = "3", everyArg = "240"] = process.argv.slice(2);
if (!outDir || !channel) throw new Error("Uso: tsx src/dev/harvest-stream-faces.ts <cartella> <canale> [live] [ogni_secondi]");
const MIN_FACE_H = 190; // su 1080p: sotto è una webcam piccola in un angolo
await fsp.mkdir(outDir, { recursive: true });

const list = await run("yt-dlp", ["--flat-playlist", "--playlist-end", vodsArg, "--print", "%(id)s|%(duration)s", `https://www.twitch.tv/${channel}/videos?filter=archives&sort=time`], { maxBuffer: 1 << 24 });
const vods = list.stdout.trim().split("\n").map((l) => l.split("|")).filter((x) => x[0]);
const kept: Array<{ file: string; vod: string; t: number; faceH: number }> = [];
for (const [vod, durStr] of vods) {
  const dur = Number(durStr);
  let url: string;
  try {
    url = (await run("yt-dlp", ["-g", "-f", "best[height<=1080]", `https://www.twitch.tv/videos/${vod!.replace(/^v/, "")}`], { maxBuffer: 1 << 24 })).stdout.trim().split("\n")[0]!;
  } catch (e) {
    console.log(`salto ${vod}: ${(e as Error).message.slice(0, 120)}`);
    continue;
  }
  for (let t = 60; t < dur - 60; t += Number(everyArg)) {
    const frame = path.join(outDir, `_f.jpg`);
    try {
      await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(t), "-i", url, "-frames:v", "1", "-q:v", "2", frame], { timeout: 60_000 });
    } catch {
      continue;
    }
    const img = sharp(frame);
    const { width = 0, height = 0 } = await img.metadata();
    if (!width) continue;
    const rgb = await img.clone().resize(320, 240, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const bgr = Buffer.alloc(rgb.length);
    for (let i = 0; i < rgb.length; i += 3) {
      bgr[i] = rgb[i + 2]!;
      bgr[i + 1] = rgb[i + 1]!;
      bgr[i + 2] = rgb[i]!;
    }
    const face = (await detectFaces(bgr, width, height)).sort((a, b) => b.height - a.height)[0];
    if (!face || face.height < MIN_FACE_H * (height / 1080)) continue;
    // Busto largo attorno al volto (testa, spalle): add-labeled-faces poi ritaglia e scontorna.
    const side = Math.round(face.height * 3.2);
    const left = Math.round(Math.max(0, Math.min(width - Math.min(side, width), face.x + face.width / 2 - side / 2)));
    const top = Math.round(Math.max(0, Math.min(height - Math.min(side, height), face.y - face.height * 0.9)));
    const file = path.join(outDir, `${channel}-${vod}-${t}.jpg`);
    await sharp(frame).extract({ left, top, width: Math.min(side, width - left), height: Math.min(side, height - top) }).jpeg({ quality: 95 }).toFile(file);
    kept.push({ file, vod: vod!, t, faceH: Math.round(face.height) });
    console.log(`${vod} ${Math.round(t / 60)} min: volto ${Math.round(face.height)}px`);
  }
}
await fsp.writeFile(path.join(outDir, `${channel}.json`), JSON.stringify(kept, null, 1));
console.log(`${kept.length} primi piani da ${channel}`);

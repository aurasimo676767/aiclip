import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runFfmpeg, probeVideo } from "../lib/ffmpeg.js";
import { LocalFasterWhisperProvider } from "../providers/transcription/local-faster-whisper-provider.js";
import { env } from "../env.js";

/**
 * "Guarda" un video mandato da simo (es. un TikTok salvato e inoltrato su Telegram): foglio di
 * fotogrammi numerati col secondo + trascrizione con Whisper locale (gratis).
 * Uso: tsx src/dev/look-at-video.ts <video> [fotogrammi=16]
 */
const [file, countArg = "16"] = process.argv.slice(2);
const dir = path.join(path.dirname(file!), `${path.basename(file!, path.extname(file!))}-frames`);
await fsp.mkdir(dir, { recursive: true });
const { durationSeconds, width, height } = await probeVideo(file!);
const n = Number(countArg);
const times = Array.from({ length: n }, (_, i) => (durationSeconds * (i + 0.5)) / n);
const cellW = 270;
const cellH = Math.round((cellW * (height || 1920)) / (width || 1080));
const tiles = [];
for (const [i, t] of times.entries()) {
  const out = path.join(dir, `f${i}.jpg`);
  await runFfmpeg(["-y", "-ss", t.toFixed(2), "-i", file!, "-frames:v", "1", "-q:v", "3", out]);
  const img = await sharp(out).resize(cellW, cellH, { fit: "contain", background: "#000" }).toBuffer();
  const label = Buffer.from(`<svg width="${cellW}" height="34"><rect width="70" height="34" fill="#000" fill-opacity="0.7"/><text x="8" y="25" font-size="22" fill="#ffd400" font-family="Arial" font-weight="bold">${t.toFixed(1)}s</text></svg>`);
  tiles.push({ input: await sharp(img).composite([{ input: label, left: 0, top: 0 }]).toBuffer(), left: (i % 8) * cellW, top: Math.floor(i / 8) * cellH });
}
const sheet = path.join(dir, "fotogrammi.jpg");
await sharp({ create: { width: 8 * cellW, height: Math.ceil(n / 8) * cellH, channels: 3, background: "#111" } }).composite(tiles).jpeg({ quality: 82 }).toFile(sheet);
const audio = path.join(dir, "audio.mp3");
await runFfmpeg(["-y", "-i", file!, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audio]);
const transcript = await new LocalFasterWhisperProvider(env.LOCAL_WHISPER_URL, env.WORKER_TMP_DIR).transcribe(audio).catch((e) => null as unknown as { segments: Array<{ start: number; text: string }> } | null);
console.log(`durata ${durationSeconds.toFixed(1)} s, ${width}x${height} → ${sheet}`);
for (const s of transcript?.segments ?? []) console.log(`[${s.start.toFixed(1)}] ${s.text.trim()}`);

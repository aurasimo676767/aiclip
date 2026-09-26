import path from "node:path";
import fsp from "node:fs/promises";
import sharp from "sharp";
import { runFfmpeg } from "../lib/ffmpeg.js";

/**
 * Sceglie il fotogramma di gioco più adatto come sfondo di copertina: il più colorato e ricco di
 * dettagli fra N campioni del tratto (i menu grigi, le schermate nere e i caricamenti perdono).
 * Uso: tsx src/dev/pick-game-frame.ts <sorgente> <inizio> <fine> <out.jpg> [campioni=16]
 */
const [src, s, e, out, nArg = "16"] = process.argv.slice(2);
const start = Number(s);
const end = Number(e);
const n = Number(nArg);
const dir = path.join(path.dirname(path.resolve(out!)), "frames-tmp");
await fsp.mkdir(dir, { recursive: true });
let best = { score: -1, file: "" };
for (let i = 0; i < n; i++) {
  const t = start + ((end - start) * (i + 0.5)) / n;
  const file = path.join(dir, `f${i}.jpg`);
  await runFfmpeg(["-y", "-ss", t.toFixed(2), "-i", src!, "-frames:v", "1", "-q:v", "2", file]);
  const stats = await sharp(file).resize(320, 180).stats();
  const [r, g, b] = stats.channels;
  // Colore (differenza fra canali) + dettaglio (entropia): un menu grigio o uno schermo nero perdono.
  const colorfulness = Math.abs(r!.mean - g!.mean) + Math.abs(g!.mean - b!.mean) + (r!.stdev + g!.stdev + b!.stdev) / 3;
  const score = colorfulness * 0.6 + stats.entropy * 12;
  if (score > best.score) best = { score, file };
}
await fsp.copyFile(best.file, out!);
console.log("scelto", best.file, best.score.toFixed(1));

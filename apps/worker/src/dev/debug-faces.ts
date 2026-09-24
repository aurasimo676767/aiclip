import { extractRawFrameBGR } from "../face-tracking/frame-extractor.js";
import { detectFaces } from "../face-tracking/onnx-face-detector.js";

/**
 * Uso: tsx src/dev/debug-faces.ts <video> <width> <height> <start> <end> [passo=0.5]
 * Stampa TUTTI i volti rilevati, campione per campione: serve a capire da dove viene un
 * "soggetto" sbagliato (un falso positivo isolato o un volto vero ma di un'altra persona).
 */
const [video, w, h, start, end, step = "0.5"] = process.argv.slice(2);
if (!video || !w || !h || !start || !end) throw new Error("Uso: tsx src/dev/debug-faces.ts <video> <w> <h> <start> <end> [passo]");
const W = Number(w);
const H = Number(h);

for (let t = Number(start); t <= Number(end); t += Number(step)) {
  const frame = await extractRawFrameBGR(video, t);
  const faces = await detectFaces(frame, W, H);
  const desc = faces
    .map((f) => `x=${Math.round(f.x)} y=${Math.round(f.y)} ${Math.round(f.width)}x${Math.round(f.height)} (h ${((f.height / H) * 100).toFixed(0)}%) s=${f.score.toFixed(2)}`)
    .join("  |  ");
  console.log(`${(t - Number(start)).toFixed(1).padStart(5)}s  ${desc || "-"}`);
}

import "dotenv/config";
import { scoreActiveSpeakers } from "../face-tracking/active-speaker.js";
import { extractRawFrameBGR } from "../face-tracking/frame-extractor.js";
import { detectFaces, type FaceBox } from "../face-tracking/onnx-face-detector.js";
import { probeVideo } from "../lib/ffmpeg.js";

/**
 * Prova gratis (niente API) del modello chi-parla: trova le webcam in un fotogramma e stampa,
 * secondo per secondo, quanto ciascun volto sta parlando (>0 = parla).
 * Uso: tsx src/dev/test-active-speaker.ts <video> <start> <end> [tFacce]
 */
const [video, startArg, endArg, facesAtArg] = process.argv.slice(2);
const start = Number(startArg);
const end = Number(endArg);
const probe = await probeVideo(video!);
const W = probe.width!;
const H = probe.height!;
const boxes = (await detectFaces(await extractRawFrameBGR(video!, facesAtArg ? Number(facesAtArg) : start + 1), W, H)).filter(
  (b) => b.width * b.height < W * H * 0.05,
);
const name = (b: FaceBox) => `${b.y + b.height / 2 < H / 2 ? "alto" : "basso"}-${b.x + b.width / 2 < W / 2 ? "sx" : "dx"}`;
const t0 = Date.now();
const { scores, fps } = await scoreActiveSpeakers(video!, start, end - start, boxes, W, H);
console.log(`volti: ${boxes.map(name).join(" ")} — calcolato in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const seconds = Math.floor((scores[0]?.length ?? 0) / fps);
for (let s = 0; s < seconds; s++) {
  const means = scores.map((sc) => sc.slice(s * fps, (s + 1) * fps).reduce((a, b) => a + b, 0) / fps);
  const best = means.indexOf(Math.max(...means));
  console.log(`${String(s).padStart(4)}s  ${means.map((m, k) => `${name(boxes[k]!)}:${m.toFixed(1).padStart(5)}`).join("  ")}  -> ${means[best]! > 0 ? name(boxes[best]!) : "nessuno"}`);
}

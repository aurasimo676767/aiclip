import { extractRawFrameBGR } from "../face-tracking/frame-extractor.js";
import { detectFaces } from "../face-tracking/onnx-face-detector.js";

/** Stampa i volti trovati in un fotogramma (gratis). Uso: tsx src/dev/print-faces.ts <video> <t> <W> <H> */
const [video, t, w, h] = process.argv.slice(2);
const boxes = await detectFaces(await extractRawFrameBGR(video!, Number(t)), Number(w), Number(h));
console.log(JSON.stringify(boxes.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }))));

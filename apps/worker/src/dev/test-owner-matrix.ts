import "dotenv/config";
import fs from "node:fs";
import { extractRawFrameBGR } from "../face-tracking/frame-extractor.js";
import { identifyWebcams, loadPeopleReferences } from "../face-tracking/face-identity.js";
import { detectFaces, type FaceBox } from "../face-tracking/onnx-face-detector.js";
import { probeVideo } from "../lib/ffmpeg.js";

/** A chi somiglia ogni webcam tra le persone etichettate (gratis). Uso: tsx src/dev/test-owner-matrix.ts <userId> <file> <t> */
const [userId, file, tArg] = process.argv.slice(2);
const t = Number(tArg);
const dir = "tmp/test-owner";
fs.mkdirSync(dir, { recursive: true });
const people = await loadPeopleReferences(userId!, dir);
console.log("persone:", people.map((p) => `${p.label}(${p.embeddings.length})`).join(" "));
const probe = await probeVideo(file!);
const W = probe.width!;
const H = probe.height!;
const boxes = (await detectFaces(await extractRawFrameBGR(file!, t), W, H)).filter((b) => b.width * b.height < W * H * 0.05);
const name = (b: FaceBox) => `${b.y + b.height / 2 < H / 2 ? "alto" : "basso"}-${b.x + b.width / 2 < W / 2 ? "sx" : "dx"}`;
const ids = await identifyWebcams(file!, boxes.map(() => [t - 10, t - 5, t, t + 5, t + 10]), boxes, W, H, people);
console.log(boxes.map((b, i) => `${name(b)}: ${ids[i]!.label ?? "?"} ${ids[i]!.similarity.toFixed(2)}`).join("  "));

import { extractCandidateFrameJpegs } from "../providers/ai/frame-sampler.js";

const videoPath = process.argv[2];
if (!videoPath) throw new Error("Uso: tsx test-frame-sampler.ts <video> <start> <end> <count>");
const start = Number(process.argv[3] ?? "5");
const end = Number(process.argv[4] ?? "15");
const count = Number(process.argv[5] ?? "3");

extractCandidateFrameJpegs(videoPath, start, end, count)
  .then((frames) => {
    console.log("frame ottenuti:", frames.length);
    frames.forEach((f, i) => console.log("frame", i, "bytes base64:", f.length));
  })
  .catch((e) => {
    console.error("ERRORE", e);
    process.exit(1);
  });

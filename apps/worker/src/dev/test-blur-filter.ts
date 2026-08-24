import { buildVideoFilterComplex } from "../render/build-video-filter.js";
import { runFfmpeg } from "../lib/ffmpeg.js";
import fs from "node:fs";

const videoPath = process.argv[2];
if (!videoPath) throw new Error("Uso: tsx test-blur-filter.ts <video>");

// Layout sintetico: split_vertical con due blurRegions (una dentro il crop "bottom", una fuori,
// per verificare che l'intersezione/scarto funzioni), su un source ipotizzato 1920x1080.
const filterComplex = buildVideoFilterComplex({
  layout: {
    type: "split_vertical",
    topCrops: [{ startSeconds: 0, endSeconds: 5, crop: { x: 100, y: 100, width: 300, height: 300 } }],
    bottom: { x: 0, y: 0, width: 1920, height: 1080 },
    topRatio: 0.35,
    blurRegions: [
      { x: 1600, y: 700, width: 200, height: 200 }, // dentro bottom
      { x: -500, y: -500, width: 100, height: 100 }, // fuori bottom, deve essere scartata
      { x: 1919, y: 500, width: 100, height: 100 }, // overlap sub-pixel col bordo destro (1920), caso che causava crop w=0
    ],
  },
  zoomExpression: "1.0",
  assSubtitlesPath: "",
  showProgressBar: false,
  clipDurationSeconds: 5,
});

console.log("--- filter_complex generato ---");
console.log(filterComplex);

// Rimuovo lo step sottotitoli (richiede un file .ass reale che qui non ho) per isolare il test sul blur.
const withoutSubs = filterComplex
  .replace(/;\n\[subbed\]null\[vout\]/, "")
  .replace(/subtitles='.*?'\[subbed\]/, "null[vout]");

fs.writeFileSync("test-blur-out.mp4", "");
runFfmpeg(["-y", "-i", videoPath, "-t", "3", "-filter_complex", withoutSubs, "-map", "[vout]", "-an", "test-blur-out.mp4"])
  .then(() => console.log("OK: ffmpeg ha renderizzato senza errori -> test-blur-out.mp4"))
  .catch((e) => {
    console.error("ERRORE ffmpeg:", e.message);
    process.exit(1);
  });

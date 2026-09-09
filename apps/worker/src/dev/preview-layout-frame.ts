import path from "node:path";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";
import { buildVideoFilterComplex } from "../render/build-video-filter.js";
import { runFfmpeg } from "../lib/ffmpeg.js";

/**
 * Renderizza un singolo fotogramma della composizione REALE (layout calcolato dal tracker +
 * filtro ffmpeg di produzione) per controllare a occhio inquadratura e centratura, senza dover
 * generare una clip intera.
 * Uso: tsx src/dev/preview-layout-frame.ts <video> <width> <height> <start> <end> [out.png]
 */
const [videoPath, w, h, start, end, outArg] = process.argv.slice(2);
if (!videoPath || !w || !h || !start || !end) {
  throw new Error("Uso: tsx preview-layout-frame.ts <video> <width> <height> <start> <end> [out.png]");
}
const outPath = outArg ?? "layout-preview.png";
const startSeconds = Number(start);
const endSeconds = Number(end);

const layout = await new ReactionCamFaceTracker().computeLayout({
  sourceVideoPath: videoPath,
  sourceWidth: Number(w),
  sourceHeight: Number(h),
  startSeconds,
  endSeconds,
});
console.log("Layout:", layout.type);

// Sottotitoli esclusi: qui interessa solo la composizione video.
const filterComplex = buildVideoFilterComplex({
  layout,
  assSubtitlesPath: "",
  showProgressBar: false,
  clipDurationSeconds: endSeconds - startSeconds,
})
  .split(";\n")
  .filter((step) => !step.includes("subtitles="))
  .concat("[scaled]null[vout]")
  .filter((step) => !step.includes("[subbed]null[vout]"))
  .join(";\n");

await runFfmpeg([
  "-y",
  "-ss",
  String(startSeconds + (endSeconds - startSeconds) / 2),
  "-i",
  videoPath,
  "-filter_complex",
  filterComplex,
  "-map",
  "[vout]",
  "-frames:v",
  "1",
  path.resolve(outPath),
]);

console.log("Fotogramma salvato in", path.resolve(outPath));

import path from "node:path";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";
import fs from "node:fs";
import { buildVideoFilterComplex, type ContentView } from "../render/build-video-filter.js";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { toFfmpegFilterPath } from "../render/ffmpeg-filter-utils.js";

/**
 * Compone l'INTERA clip col layout del tracker e il filtro ffmpeg di produzione (senza sottotitoli)
 * e ne salva un foglio di N fotogrammi equidistanti: serve a vedere l'inquadratura nel tempo, non
 * un fotogramma solo — i difetti di composizione stanno quasi sempre in un tratto della clip.
 * Uso: tsx src/dev/preview-layout-sheet.ts <video> <width> <height> <start> <end> <out.jpg> [fotogrammi=8] [views.json]
 * views.json: tratti del pannello del gioco (ContentView[], tempi della clip) da provare a mano.
 */
const [videoPath, w, h, start, end, outArg, countArg = "8", viewsArg] = process.argv.slice(2);
if (!videoPath || !w || !h || !start || !end || !outArg) {
  throw new Error("Uso: tsx preview-layout-sheet.ts <video> <width> <height> <start> <end> <out.jpg> [fotogrammi]");
}
const startSeconds = Number(start);
const duration = Number(end) - startSeconds;
const count = Number(countArg);
// Timestamp su ogni fotogramma: senza, è facile attribuire un difetto al tratto sbagliato.
const FONT = toFfmpegFilterPath(path.resolve("assets/fonts/Anton-Regular.ttf"));

const layout = await new ReactionCamFaceTracker().computeLayout({
  sourceVideoPath: videoPath,
  sourceWidth: Number(w),
  sourceHeight: Number(h),
  startSeconds,
  endSeconds: Number(end),
});
if (layout.type === "scenes") {
  console.log("LAYOUT scenes:", layout.scenes.map((s) => `${s.startSeconds.toFixed(1)}-${s.endSeconds.toFixed(1)} ${s.composition.kind}${s.composition.kind === "crop" ? `@${s.composition.crop.x}` : ""}`).join(" | "));
} else {
  console.log("LAYOUT split_vertical: bottom", JSON.stringify(layout.bottom), "top", layout.topCrops.length, "tratti");
}

const filterComplex = buildVideoFilterComplex({
  layout,
  assSubtitlesPath: "",
  showProgressBar: false,
  clipDurationSeconds: duration,
  contentViews: viewsArg ? (JSON.parse(fs.readFileSync(viewsArg, "utf8")) as ContentView[]) : [],
})
  .split(";\n")
  .filter((step) => !step.includes("subtitles=") && !step.includes("[subbed]"))
  // Fotogrammi a metà di ogni intervallo, rimpiccioliti e affiancati in un'unica immagine.
  .concat(
    `[scaled]fps=${(count / duration).toFixed(5)},scale=216:384,` +
      `drawtext=fontfile='${FONT}':text='%{pts\\:flt\\:1}s':x=6:y=6:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6,` +
      `tile=${count}x1:padding=4:color=white[vout]`,
  )
  .join(";\n");

await runFfmpeg(["-y", "-ss", String(startSeconds), "-t", String(duration), "-i", videoPath, "-filter_complex", filterComplex, "-map", "[vout]", "-frames:v", "1", path.resolve(outArg)]);
console.log("Foglio salvato in", path.resolve(outArg));

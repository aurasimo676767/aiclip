import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";
import { buildVideoFilterComplex } from "../render/build-video-filter.js";
import { runFfmpeg } from "../lib/ffmpeg.js";

const videoPathArg = process.argv[2];
const startSeconds = Number(process.argv[3]);
const endSeconds = Number(process.argv[4]);
if (!videoPathArg || Number.isNaN(startSeconds) || Number.isNaN(endSeconds)) {
  throw new Error("Uso: tsx test-mixed-layout.ts <video> <start> <end>");
}
const videoPath: string = videoPathArg;

async function main() {
  const tracker = new ReactionCamFaceTracker();
  const layout = await tracker.computeLayout({ sourceVideoPath: videoPath, sourceWidth: 1920, sourceHeight: 1080, startSeconds, endSeconds });
  console.log("Layout type:", layout.type);
  if (layout.type !== "mixed") {
    console.log("Non è mixed, niente da testare qui con questo intervallo.");
    return;
  }

  const filterComplex = buildVideoFilterComplex({
    layout,
    zoomExpression: "1.0",
    assSubtitlesPath: "",
    showProgressBar: false,
    clipDurationSeconds: endSeconds - startSeconds,
  });

  const withoutSubs = filterComplex
    .replace(/;\n\[subbed\]null\[vout\]/, "")
    .replace(/subtitles='.*?'\[subbed\]/, "null[vout]");

  await runFfmpeg([
    "-y",
    "-ss",
    String(startSeconds),
    "-i",
    videoPath,
    "-t",
    String(endSeconds - startSeconds),
    "-filter_complex",
    withoutSubs,
    "-map",
    "[vout]",
    "-an",
    "test-mixed-out.mp4",
  ]);
  console.log("OK: test-mixed-out.mp4 renderizzato");
}

main().catch((e) => {
  console.error("ERRORE:", e);
  process.exit(1);
});

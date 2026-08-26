import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";

const videoPathArg = process.argv[2];
const sourceWidth = Number(process.argv[3]);
const sourceHeight = Number(process.argv[4]);
const startSeconds = Number(process.argv[5]);
const endSeconds = Number(process.argv[6]);

if (!videoPathArg || !sourceWidth || !sourceHeight || Number.isNaN(startSeconds) || Number.isNaN(endSeconds)) {
  throw new Error("Uso: tsx debug-compute-layout.ts <video> <width> <height> <start> <end>");
}
const videoPath: string = videoPathArg;

async function main() {
  const tracker = new ReactionCamFaceTracker();
  const layout = await tracker.computeLayout({ sourceVideoPath: videoPath, sourceWidth, sourceHeight, startSeconds, endSeconds });

  console.log("\n=== LAYOUT TYPE:", layout.type, layout.type === "single" ? `backgroundFill=${layout.backgroundFill}` : "", "===");
  if (layout.type === "single") {
    for (const c of layout.crops) {
      console.log(
        `  [${c.startSeconds.toFixed(1)}-${c.endSeconds.toFixed(1)}] crop x=${c.crop.x} y=${c.crop.y} w=${c.crop.width} h=${c.crop.height}`,
      );
    }
  } else {
    console.log("  topRatio:", layout.topRatio, "bottom:", JSON.stringify(layout.bottom), "blurRegions:", JSON.stringify(layout.blurRegions));
    for (const c of layout.topCrops) {
      console.log(
        `  [${c.startSeconds.toFixed(1)}-${c.endSeconds.toFixed(1)}] top x=${c.crop.x} y=${c.crop.y} w=${c.crop.width} h=${c.crop.height}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

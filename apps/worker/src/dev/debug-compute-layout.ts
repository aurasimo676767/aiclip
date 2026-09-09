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

  console.log("\n=== LAYOUT TYPE:", layout.type, "===");
  if (layout.type === "scenes") {
    for (const s of layout.scenes) {
      const t = `  [${s.startSeconds.toFixed(1)}-${s.endSeconds.toFixed(1)}]`;
      const c = s.composition;
      if (c.kind === "crop") console.log(`${t} ritaglio x=${c.crop.x} w=${c.crop.width} h=${c.crop.height}`);
      else if (c.kind === "fit") console.log(`${t} frame intero su sfondo sfocato`);
      else console.log(`${t} template: cam ${c.cam.width}x${c.cam.height}@${c.cam.x},${c.cam.y} | contenuto ${c.content.width}x${c.content.height}@${c.content.x} | topRatio ${c.topRatio.toFixed(3)}`);
    }
    return;
  }

  console.log("  topRatio:", layout.topRatio, "bottom:", JSON.stringify(layout.bottom), "blurRegions:", JSON.stringify(layout.blurRegions));
  // Crop identici consecutivi = stesso speaker: se si alternano a ogni riga, la webcam sta
  // saltando tra persone diverse troppo spesso.
  for (const c of layout.topCrops) {
    console.log(
      `  [${c.startSeconds.toFixed(1)}-${c.endSeconds.toFixed(1)}] top x=${c.crop.x} y=${c.crop.y} w=${c.crop.width} h=${c.crop.height}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { extractRawFrameBGR } from "../face-tracking/frame-extractor.js";
import { detectFaces } from "../face-tracking/onnx-face-detector.js";
import { computeMouthMotion } from "../face-tracking/mouth-motion.js";

const videoPathArg = process.argv[2];
if (!videoPathArg) throw new Error("Uso: tsx debug-reaction-cam.ts <video> <width> <height> <t1> <t2> ...");
const videoPath: string = videoPathArg;
const sourceWidth = Number(process.argv[3]);
const sourceHeight = Number(process.argv[4]);
const timestamps = process.argv.slice(5).map(Number);

const WEBCAM_MAX_AREA_RATIO = 0.05;
const WEBCAM_CENTER_MARGIN = 0.3;

function isWebcamLike(box: { x: number; y: number; width: number; height: number }): boolean {
  const areaRatio = (box.width * box.height) / (sourceWidth * sourceHeight);
  if (areaRatio >= WEBCAM_MAX_AREA_RATIO) return false;
  const ncx = (box.x + box.width / 2) / sourceWidth;
  const ncy = (box.y + box.height / 2) / sourceHeight;
  const offCenterX = ncx < WEBCAM_CENTER_MARGIN || ncx > 1 - WEBCAM_CENTER_MARGIN;
  const offCenterY = ncy < WEBCAM_CENTER_MARGIN || ncy > 1 - WEBCAM_CENTER_MARGIN;
  return offCenterX && offCenterY;
}

async function main() {
  for (const t of timestamps) {
    console.log(`\n=== t=${t}s ===`);
    const frameA = await extractRawFrameBGR(videoPath, t);
    const boxes = await detectFaces(frameA, sourceWidth, sourceHeight);
    const frameB = await extractRawFrameBGR(videoPath, t + 0.15);

    for (const box of boxes) {
      const motion = computeMouthMotion(frameA, frameB, box, sourceWidth, sourceHeight);
      const areaRatio = (box.width * box.height) / (sourceWidth * sourceHeight);
      const ncx = (box.x + box.width / 2) / sourceWidth;
      const ncy = (box.y + box.height / 2) / sourceHeight;
      console.log(
        `  box x=${box.x.toFixed(0)} y=${box.y.toFixed(0)} w=${box.width.toFixed(0)} h=${box.height.toFixed(0)}` +
          ` | area%=${(areaRatio * 100).toFixed(2)} ncx=${ncx.toFixed(2)} ncy=${ncy.toFixed(2)}` +
          ` | webcamLike=${isWebcamLike(box)} | motion=${motion.toFixed(2)} | score=${box.score.toFixed(2)}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

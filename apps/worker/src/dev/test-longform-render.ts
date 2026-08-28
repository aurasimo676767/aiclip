import path from "node:path";
import { renderLongformClip } from "../render/render-longform-clip.js";

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error("Uso: tsx src/dev/test-longform-render.ts <path-video-sorgente>");
  process.exit(1);
}

const workDir = path.join(process.cwd(), "tmp");
const outputPath = path.join(workDir, "longform-test-output.mp4");

const result = await renderLongformClip({
  sourceVideoPath: sourcePath,
  start: 5,
  end: 20,
  streamerName: "Test Streamer's Channel", // contiene un apostrofo di proposito, per testare l'escaping
  workDir,
  outputPath,
});

console.log("Render completato:", outputPath, result);

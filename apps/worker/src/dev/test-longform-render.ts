import path from "node:path";
import { renderLongformClip } from "../render/render-longform-clip.js";

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error("Uso: tsx src/dev/test-longform-render.ts <path-video-sorgente> [start] [end]");
  process.exit(1);
}
const start = process.argv[3] ? Number(process.argv[3]) : 5;
const end = process.argv[4] ? Number(process.argv[4]) : 20;

const workDir = path.join(process.cwd(), "tmp");
const outputPath = path.join(workDir, "longform-test-output.mp4");

const result = await renderLongformClip({
  sourceVideoPath: sourcePath,
  start,
  end,
  streamerName: "Test Streamer's Channel", // contiene un apostrofo di proposito, per testare l'escaping
  workDir,
  outputPath,
});

console.log("Render completato:", outputPath, result);

import fs from "node:fs";
import { DEFAULT_TEMPLATES, type RankedClip, type TranscriptSegment } from "@clipforge/shared";
import { renderClip } from "../render/render-clip.js";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";

const sourceVideoPathArg = process.argv[2];
if (!sourceVideoPathArg) throw new Error("Uso: tsx test-real-render.ts <source-video>");
const sourceVideoPath: string = sourceVideoPathArg;

const clip: RankedClip = {
  start: 425.3,
  end: 447.1,
  duration: 21.8,
  hook: "debug",
  title: "debug",
  reason: "debug",
  scores: { hook: 80, retention: 81, emotion: 70, clarity: 84, payoff: 85, virality: 78 },
  editing_style: "dynamic",
  edl: {
    template: "STORYTELLING",
    events: [
      { time: 426, scale: 1.1, action: "zoom" },
      { time: 431.2, word: "quattro zampe", action: "highlight_word" },
      { time: 437.8, word: "Goku", action: "highlight_word" },
      { time: 440.9, scale: 1.3, action: "punch_in" },
      { time: 442, word: "frisa", action: "highlight_word" },
      { time: 445.6, scale: 1.05, action: "zoom" },
    ],
  },
  hashtags: ["shorts"],
  caption: "debug",
  badges: [],
};

const segmentsPath: string = process.argv[3] ?? "transcript-segments.json";
const transcriptSegments: TranscriptSegment[] = JSON.parse(fs.readFileSync(segmentsPath, "utf-8"));

async function main() {
  fs.mkdirSync("tmp-real-render", { recursive: true });
  const result = await renderClip({
    sourceVideoPath,
    clip,
    template: DEFAULT_TEMPLATES.STORYTELLING,
    transcriptSegments,
    faceTracker: new ReactionCamFaceTracker(),
    workDir: "tmp-real-render",
    outputPath: "test-real-out.mp4",
  });
  console.log("OK, durata finale:", result.durationSeconds);
}

main().catch((e) => {
  console.error("ERRORE:", e);
  process.exit(1);
});

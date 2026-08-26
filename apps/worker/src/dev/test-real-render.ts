import fs from "node:fs";
import { DEFAULT_TEMPLATES, type RankedClip, type TranscriptSegment } from "@clipforge/shared";
import { renderClip } from "../render/render-clip.js";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";

const sourceVideoPathArg = process.argv[2];
if (!sourceVideoPathArg) throw new Error("Uso: tsx test-real-render.ts <source-video>");
const sourceVideoPath: string = sourceVideoPathArg;

const clip: RankedClip = {
  start: 426.4,
  end: 456.5,
  duration: 30.1,
  hook: "debug",
  title: "debug",
  reason: "debug",
  scores: { hook: 84, retention: 88, emotion: 85, clarity: 82, payoff: 87, virality: 86 },
  editing_style: "high_energy",
  edl: {
    template: "STREAMER",
    events: [
      { time: 428.5, scale: 1.1, action: "zoom" },
      { time: 436.7, word: "pronti", action: "highlight_word" },
      { time: 438, scale: 1.35, action: "punch_in" },
      { time: 443.4, word: "Porca vacca", action: "highlight_word" },
      { time: 444.8, scale: 1.2, action: "zoom" },
      { time: 446.9, action: "speaker_switch", speaker: "Lollo" },
      { time: 447.5, word: "Milano Centrale", action: "highlight_word" },
      { time: 453.4, scale: 1.12, action: "zoom" },
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
    template: DEFAULT_TEMPLATES.STREAMER,
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

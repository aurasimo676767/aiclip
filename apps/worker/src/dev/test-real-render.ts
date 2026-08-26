import fs from "node:fs";
import { DEFAULT_TEMPLATES, type RankedClip, type TranscriptSegment } from "@clipforge/shared";
import { renderClip } from "../render/render-clip.js";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";

const sourceVideoPathArg = process.argv[2];
if (!sourceVideoPathArg) throw new Error("Uso: tsx test-real-render.ts <source-video>");
const sourceVideoPath: string = sourceVideoPathArg;

const clip: RankedClip = {
  start: 487.8,
  end: 521.2,
  duration: 33.4,
  hook: "debug",
  title: "debug",
  reason: "debug",
  scores: { hook: 78, retention: 76, emotion: 66, clarity: 80, payoff: 79, virality: 77 },
  editing_style: "dynamic",
  edl: {
    template: "PODCAST_DYNAMIC",
    events: [
      { time: 489.5, word: "Schumacher", action: "highlight_word" },
      { time: 493.6, scale: 1.12, action: "zoom" },
      { time: 495.9, action: "speaker_switch", speaker: "Marza" },
      { time: 498.5, word: "Formula 1", action: "highlight_word" },
      { time: 504.6, scale: 1.15, action: "zoom" },
      { time: 508.3, word: "fuori pista", action: "highlight_word" },
      { time: 509.9, action: "speaker_switch", speaker: "Streamer" },
      { time: 515.3, scale: 1.25, action: "punch_in" },
      { time: 518.4, word: "colpa", action: "highlight_word" },
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
    template: DEFAULT_TEMPLATES.PODCAST_DYNAMIC,
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

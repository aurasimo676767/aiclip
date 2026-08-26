import fs from "node:fs";
import { DEFAULT_TEMPLATES, type RankedClip, type TranscriptSegment } from "@clipforge/shared";
import { renderClip } from "../render/render-clip.js";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";

const sourceVideoPathArg = process.argv[2];
if (!sourceVideoPathArg) throw new Error("Uso: tsx test-real-render.ts <source-video>");
const sourceVideoPath: string = sourceVideoPathArg;

const clip: RankedClip = {
  start: 585.8,
  end: 598.3,
  duration: 12.5,
  hook: "\"Nomina un frutto rosso\" — \"La fica\"",
  title: "\"Nomina un frutto rosso\" e lui risponde QUELLO",
  reason: "debug",
  scores: { hook: 88, retention: 84, emotion: 76, clarity: 86, payoff: 80, virality: 83 },
  editing_style: "dynamic",
  edl: {
    template: "STREAMER",
    events: [
      { time: 586, word: "rosso", action: "highlight_word" },
      { time: 587.5, action: "speaker_switch", speaker: "Marza" },
      { time: 587.6, scale: 1.3, action: "punch_in" },
      { time: 589.4, action: "speaker_switch", speaker: "Pesh" },
      { time: 591.4, word: "pomodoro", action: "highlight_word" },
      { time: 594.8, scale: 1.15, action: "zoom" },
      { time: 595, word: "ovvio", action: "highlight_word" },
    ],
  },
  hashtags: ["shorts", "quiz"],
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

import fs from "node:fs";
import { DEFAULT_TEMPLATES, type RankedClip, type TranscriptSegment } from "@clipforge/shared";
import { renderClip } from "../render/render-clip.js";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";

const sourceVideoPathArg = process.argv[2];
if (!sourceVideoPathArg) throw new Error("Uso: tsx test-real-render.ts <source-video>");
const sourceVideoPath: string = sourceVideoPathArg;

const clip: RankedClip = {
  start: 1686.5,
  end: 1727.6,
  duration: 41.1,
  hook: "debug",
  title: "debug",
  reason: "debug",
  scores: { hook: 76, retention: 78, emotion: 72, clarity: 80, payoff: 79, virality: 75 },
  editing_style: "dynamic",
  edl: {
    template: "STREAMER",
    events: [
      { time: 1687, scale: 1.1, action: "zoom" },
      { time: 1690.6, action: "speaker_switch", speaker: "Lollo" },
      { time: 1691.2, word: "telecamera", action: "highlight_word" },
      { time: 1692.5, word: "rischio", action: "highlight_word" },
      { time: 1722.5, scale: 1.15, action: "zoom" },
      { time: 1724, word: "infiammabile", action: "highlight_word" },
      { time: 1726.3, scale: 1.3, action: "punch_in" },
      { time: 1726.6, word: "prometterlo", action: "highlight_word" },
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

/**
 * Smoke test manuale della pipeline di render (crop 9:16, zoom EDL, captions, loudness),
 * SENZA bisogno di credenziali Supabase/Anthropic/OpenAI: usa un transcript ed un EDL finti.
 *
 * Uso:
 *   1. Genera un video sorgente di prova, es.:
 *      ffmpeg -y -f lavfi -i "testsrc=size=1280x720:rate=30:duration=20" \
 *             -f lavfi -i "sine=frequency=440:duration=20" \
 *             -c:v libx264 -pix_fmt yuv420p -c:a aac tmp/smoke-test/source.mp4
 *   2. pnpm --filter @clipforge/worker exec tsx src/dev/smoke-test-render.ts <path-al-video>
 */
import path from "node:path";
import type { RankedClip, TranscriptSegment } from "@clipforge/shared";
import { DEFAULT_TEMPLATES } from "@clipforge/shared";
import { renderClip } from "../render/render-clip.js";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error("Uso: tsx src/dev/smoke-test-render.ts <path-al-video-sorgente>");
    process.exit(1);
  }

  const words = [
    { word: "Questo", start: 1.0, end: 1.3 },
    { word: "è", start: 1.3, end: 1.4 },
    { word: "un", start: 1.4, end: 1.5 },
    { word: "MOMENTO", start: 1.5, end: 2.1 },
    { word: "davvero", start: 2.1, end: 2.5 },
    { word: "incredibile", start: 2.5, end: 3.2 },
    { word: "e", start: 4.0, end: 4.1 },
    { word: "sorprendente", start: 4.1, end: 4.9 },
    { word: "per", start: 5.5, end: 5.7 },
    { word: "chiunque", start: 5.7, end: 6.3 },
    { word: "lo", start: 6.3, end: 6.4 },
    { word: "ascolti", start: 6.4, end: 7.0 },
  ];

  const segments: TranscriptSegment[] = [
    { id: 0, start: 1.0, end: 3.2, text: "Questo è un MOMENTO davvero incredibile", words: words.slice(0, 6) },
    { id: 1, start: 4.0, end: 7.0, text: "e sorprendente per chiunque lo ascolti", words: words.slice(6) },
  ];

  const clip: RankedClip = {
    start: 0,
    end: 10,
    duration: 10,
    hook: "Un momento davvero incredibile",
    title: "Smoke test clip",
    reason: "Test manuale della pipeline di render",
    scores: { hook: 90, retention: 85, emotion: 80, clarity: 88, payoff: 82, virality: 79 },
    editing_style: "dynamic",
    hashtags: ["shorts", "smoketest"],
    edl: {
      template: "PODCAST_DYNAMIC",
      events: [
        { time: 1.5, action: "zoom", scale: 1.15 },
        { time: 4.1, action: "highlight_word", word: "MOMENTO" },
        { time: 5.5, action: "speaker_switch", speaker: "speaker_1" },
      ],
    },
  };

  const template = DEFAULT_TEMPLATES.PODCAST_DYNAMIC;
  const workDir = path.join("tmp", "smoke-test", "work");
  const outputPath = path.join("tmp", "smoke-test", "output.mp4");

  console.log("Avvio render di prova...");
  const result = await renderClip({
    sourceVideoPath: sourcePath,
    clip,
    template,
    transcriptSegments: segments,
    faceTracker: new ReactionCamFaceTracker(),
    workDir,
    outputPath,
  });

  console.log(`Render completato: ${outputPath} (${result.durationSeconds.toFixed(2)}s)`);
}

main().catch((err) => {
  console.error("Smoke test fallito:", err);
  process.exit(1);
});

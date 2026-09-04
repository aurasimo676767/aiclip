import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import type { TranscriptSegment } from "@clipforge/shared";
import { detectClipCandidates } from "../providers/ai/candidates.js";
import { rankAndBuildEdl } from "../providers/ai/ranking.js";
import { env } from "../env.js";

const VIDEO_ID_ARG = process.argv[2];
if (!VIDEO_ID_ARG) {
  console.error("Uso: tsx src/dev/test-clip-selection-prompt.ts <video_id>");
  process.exit(1);
}
const VIDEO_ID: string = VIDEO_ID_ARG;

async function main() {
  const { data: video, error: videoErr } = await supabase
    .from("videos")
    .select("id,project_id,original_filename,duration_seconds")
    .eq("id", VIDEO_ID)
    .single();
  if (videoErr || !video) throw new Error(`Video non trovato: ${videoErr?.message}`);

  const { data: project, error: projectErr } = await supabase
    .from("projects")
    .select("user_id")
    .eq("id", video.project_id)
    .single();
  if (projectErr || !project) throw new Error(`Project non trovato: ${projectErr?.message}`);

  const { data: transcript, error: transcriptErr } = await supabase
    .from("transcripts")
    .select("segments,duration_seconds")
    .eq("video_id", VIDEO_ID)
    .single();
  if (transcriptErr || !transcript) throw new Error(`Transcript non trovato: ${transcriptErr?.message}`);

  const segments = transcript.segments as unknown as TranscriptSegment[];
  console.log(`Video: ${video.original_filename} — ${segments.length} segmenti, ${transcript.duration_seconds}s`);

  console.log("\n=== STAGE 1: candidate detection (Haiku) ===");
  const candidates = await detectClipCandidates(segments, {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL_CHEAP,
    videoTitle: video.original_filename,
    videoDurationSeconds: transcript.duration_seconds,
  });
  for (const c of candidates) {
    console.log(`\n[${c.start.toFixed(1)}s -> ${c.end.toFixed(1)}s] (${(c.end - c.start).toFixed(1)}s)`);
    console.log(`  hook: ${c.hook}`);
    console.log(`  reason: ${c.reason}`);
  }

  console.log("\n\n=== STAGE 2: ranking + EDL (Sonnet, senza frame: video sorgente non scaricato in questo test) ===");
  const ranked = await rankAndBuildEdl(candidates, segments, {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL_STRONG,
    videoTitle: video.original_filename,
    sourceVideoPath: "/nonexistent/no-video.mp4",
    userId: project.user_id,
  });

  for (const c of ranked) {
    console.log(`\n[${c.start.toFixed(1)}s -> ${c.end.toFixed(1)}s] (${c.duration.toFixed(1)}s)`);
    console.log(`  hook: "${c.hook}"`);
    console.log(`  title: ${c.title}`);
    console.log(`  scores: ${JSON.stringify(c.scores)}`);
    console.log(`  badges: ${c.badges.join(", ") || "(nessuno)"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

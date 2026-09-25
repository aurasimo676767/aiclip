import "dotenv/config";
import fs from "node:fs";
import type { TranscriptSegment } from "@clipforge/shared";
import { supabase } from "../lib/supabase.js";
import { buildVideosFromTimeline, fmt, type TimelineBlock } from "../providers/ai/longform-plan.js";
import { describePlannedVideos } from "../providers/ai/longform-metadata.js";
import { env } from "../env.js";

/**
 * Titoli/descrizioni/punteggi dei video ricostruiti da una timeline GIÀ SALVATA (la mappa non si
 * ripaga, i confini non si rifiniscono). Uso: tsx src/dev/test-longform-metadata.ts <video_id> <plan.json>
 */
const [videoId, planPath] = process.argv.slice(2);
if (!videoId || !planPath) throw new Error("Uso: tsx src/dev/test-longform-metadata.ts <video_id> <plan.json>");

const saved = JSON.parse(fs.readFileSync(planPath, "utf8")) as { plan: { timeline: TimelineBlock[] } };
const { data: transcript } = await supabase.from("transcripts").select("segments").eq("video_id", videoId).single();
const { data: video } = await supabase.from("videos").select("original_filename,streamer_name").eq("id", videoId).single();
if (!transcript) throw new Error("Transcript mancante");

const videos = buildVideosFromTimeline(saved.plan.timeline);
const { clips, usage } = await describePlannedVideos(videos, saved.plan.timeline, transcript.segments as unknown as TranscriptSegment[], {
  apiKey: env.ANTHROPIC_API_KEY,
  model: env.ANTHROPIC_MODEL_LONGFORM,
  videoTitle: video?.original_filename ?? "",
  streamerName: video?.streamer_name ?? null,
});
console.log(`\nUso: ${JSON.stringify(usage)}\n`);
for (const c of clips) {
  console.log(`${fmt(c.start)}-${fmt(c.end)}  ${c.title}`);
  console.log(`   ${JSON.stringify(c.scores)} ${c.badges.join(",")}`);
  console.log(`   ${c.caption}`);
  console.log(`   #${c.hashtags.join(" #")}`);
}

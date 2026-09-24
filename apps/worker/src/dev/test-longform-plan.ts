import "dotenv/config";
import fsp from "node:fs/promises";
import type { TranscriptSegment } from "@clipforge/shared";
import { supabase } from "../lib/supabase.js";
import { fetchTwitchChapters } from "../lib/twitch-chapters.js";
import { planLongformVideos } from "../providers/ai/longform-plan.js";
import { env } from "../env.js";

/**
 * Uso: tsx src/dev/test-longform-plan.ts <video_id> [out.json]
 * Mappa del VOD col nuovo passaggio unico, affiancata ai tagli attuali salvati in `clips`.
 */
const videoId = process.argv[2];
if (!videoId) throw new Error("Uso: tsx src/dev/test-longform-plan.ts <video_id> [out.json]");

const fmt = (sec: number) => {
  const s = Math.round(sec);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const { data: video } = await supabase.from("videos").select("*").eq("id", videoId).single();
const { data: transcript } = await supabase.from("transcripts").select("segments,duration_seconds").eq("video_id", videoId).single();
if (!video || !transcript) throw new Error("Video o transcript non trovati");
const { data: oldClips } = await supabase.from("clips").select("start_time,end_time,title").eq("video_id", videoId).eq("format", "longform");

const chapters = await fetchTwitchChapters(video.source_url);
console.log(`\n=== Capitoli Twitch (${chapters.length}) ===`);
for (const c of chapters) console.log(`  ${fmt(c.start)}-${fmt(c.end)} ${c.title}`);

const startedAt = Date.now();
const plan = await planLongformVideos(transcript.segments as unknown as TranscriptSegment[], {
  apiKey: env.ANTHROPIC_API_KEY,
  model: env.ANTHROPIC_MODEL_LONGFORM,
  videoTitle: video.original_filename ?? "",
  streamerName: video.streamer_name,
  videoDurationSeconds: transcript.duration_seconds,
  chapters,
});

console.log(`\n=== Tagli ATTUALI (${oldClips?.length ?? 0}) ===`);
for (const c of (oldClips ?? []).sort((a, b) => a.start_time - b.start_time)) {
  console.log(`  ${fmt(c.start_time)}-${fmt(c.end_time)} (${Math.round((c.end_time - c.start_time) / 60)}m) ${c.title.slice(0, 90)}`);
}
console.log(`\n=== NUOVA mappa (${plan.videos.length}) — ${((Date.now() - startedAt) / 1000).toFixed(0)}s, ${JSON.stringify(plan.usage)} ===`);
for (const v of plan.videos) {
  console.log(`  ${fmt(v.start)}-${fmt(v.end)} (${Math.round((v.end - v.start) / 60)}m) [${v.kind}${v.part ? ` p${v.part}` : ""}] ${v.topic}`);
  console.log(`      apre: ${v.opening}  |  chiude: ${v.closing}`);
}

if (process.argv[3]) {
  await fsp.writeFile(process.argv[3], JSON.stringify({ videoId, chapters, plan }, null, 2));
  console.log(`\nSalvato in ${process.argv[3]}`);
}

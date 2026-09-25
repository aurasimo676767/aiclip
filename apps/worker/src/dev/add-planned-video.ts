import "dotenv/config";
import fs from "node:fs";
import type { TranscriptSegment } from "@clipforge/shared";
import { supabase } from "../lib/supabase.js";
import { fmt, type LongformPlanResult } from "../providers/ai/longform-plan.js";
import { refineVideoBoundaries } from "../providers/ai/longform-boundaries.js";
import { describePlannedVideos } from "../providers/ai/longform-metadata.js";
import { env } from "../env.js";

/**
 * Aggiunge a un VOD già elaborato UN video che la mappa del giro vero aveva perso, prendendolo da
 * una mappa salvata da test-longform-plan.ts: rifinisce inizio/fine (Opus), scrive titolo e
 * descrizione (Sonnet) e lo mette in coda di render come le altre clip. A PAGAMENTO (~0,04 $).
 * Uso: tsx src/dev/add-planned-video.ts <video_id> <plan.json> <parte del nome dell'attività>
 */
const [videoId, planPath, activityQuery] = process.argv.slice(2);
if (!videoId || !planPath || !activityQuery) throw new Error("Uso: tsx src/dev/add-planned-video.ts <video_id> <plan.json> <attività>");

const saved = JSON.parse(fs.readFileSync(planPath, "utf8")) as { plan: LongformPlanResult };
const planned = saved.plan.videos.find((v) => v.activity.toLowerCase().includes(activityQuery.toLowerCase()));
if (!planned) throw new Error(`Nessun video della mappa contiene "${activityQuery}"`);

const { data: video } = await supabase.from("videos").select("id,project_id,original_filename,streamer_name").eq("id", videoId).single();
const { data: transcript } = await supabase.from("transcripts").select("segments,duration_seconds").eq("video_id", videoId).single();
const { data: project } = await supabase.from("projects").select("auto_generate_clips").eq("id", video!.project_id).single();
const { data: existing } = await supabase.from("clips").select("start_time,end_time").eq("video_id", videoId);
if (!video || !transcript) throw new Error("Video o transcript mancante");
const segments = transcript.segments as unknown as TranscriptSegment[];

// Si rifinisce SOLO questo video (due confini, pochi centesimi), poi lo si tiene fuori dai video
// che esistono già: la rifinitura può guardare fino a 12 minuti oltre la fine.
const refined = await refineVideoBoundaries([planned], segments, {
  apiKey: env.ANTHROPIC_API_KEY,
  model: env.ANTHROPIC_MODEL_LONGFORM_BOUNDARIES,
  videoDurationSeconds: transcript.duration_seconds,
});
const target = { ...(refined.videos[0] ?? planned) };
for (const c of existing ?? []) {
  if (c.start_time >= target.start && c.start_time < target.end) target.end = c.start_time;
  if (c.end_time > target.start && c.end_time <= target.end) target.start = c.end_time;
}
console.log(`Confini: mappa ${fmt(planned.start)}-${fmt(planned.end)} -> rifiniti ${fmt(target.start)}-${fmt(target.end)}`);

const { clips } = await describePlannedVideos([target], saved.plan.timeline, segments, {
  apiKey: env.ANTHROPIC_API_KEY,
  model: env.ANTHROPIC_MODEL_LONGFORM,
  videoTitle: video.original_filename ?? "",
  streamerName: video.streamer_name,
});
const clip = clips[0]!;
console.log(`Titolo: ${clip.title}`);

const autoRender = project?.auto_generate_clips === true;
const { data: inserted, error } = await supabase
  .from("clips")
  .insert({
    project_id: video.project_id,
    video_id: video.id,
    start_time: clip.start,
    end_time: clip.end,
    duration: clip.duration,
    title: clip.title,
    hook: clip.hook,
    reason: clip.reason,
    scores: clip.scores,
    editing_style: "clean",
    template: "PODCAST_CLEAN",
    edl: { template: "PODCAST_CLEAN", events: [] },
    hashtags: clip.hashtags,
    caption: clip.caption,
    badges: clip.badges,
    format: "longform",
    status: autoRender ? "QUEUED" : "SUGGESTED",
  })
  .select("id")
  .single();
if (error || !inserted) throw new Error(`Inserimento fallito: ${error?.message}`);
if (autoRender) {
  const { error: jobError } = await supabase.from("render_jobs").insert({ clip_id: inserted.id });
  if (jobError) throw new Error(`Render job non creato: ${jobError.message}`);
}
console.log(`Aggiunto ${inserted.id} (${autoRender ? "in coda di render" : "suggerito, da renderizzare dal sito"})`);

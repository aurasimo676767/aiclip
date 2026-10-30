import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { buildVideosFromTimeline, fmt, type PlannedVideo } from "../providers/ai/longform-plan.js";
import { plannedVideosAsClips } from "../providers/ai/longform-metadata.js";
import { censorText } from "@clipforge/shared";

/**
 * Aggiunge a VOD già elaborati i video che prima restavano fuori (sotto gli 8 minuti), dalla mappa
 * salvata e SENZA AI: titolo provvisorio, confini della mappa, mai montati. Toglie ciò che i video
 * esistenti coprono già; sotto i 3 minuti non aggiunge. Senza "--scrivi" stampa solo l'elenco.
 * Uso: tsx src/dev/add-skipped-videos.ts <video_id>... [--scrivi]
 */
const MIN_SECONDS = 3 * 60;
const write = process.argv.includes("--scrivi");
const ids = process.argv.slice(2).filter((a) => a !== "--scrivi");

for (const id of ids) {
  const { data: video } = await supabase.from("videos").select("id,project_id,original_filename,usage_stats").eq("id", id).single();
  const timeline = (video?.usage_stats as { longformTimeline?: { blocks?: unknown } | unknown[] } | null)?.longformTimeline;
  const blocks = (Array.isArray(timeline) ? timeline : timeline?.blocks) as Parameters<typeof buildVideosFromTimeline>[0] | undefined;
  if (!video || !blocks) throw new Error(`Mappa mancante per ${id}`);
  const { data: project } = await supabase.from("projects").select("auto_generate_clips").eq("id", video.project_id).single();
  const { data: existing } = await supabase.from("clips").select("start_time,end_time").eq("video_id", id).eq("format", "longform");

  const missing: PlannedVideo[] = [];
  for (const planned of buildVideosFromTimeline(blocks)) {
    let pieces = [{ start: planned.start, end: planned.end }];
    for (const c of existing ?? []) {
      pieces = pieces.flatMap((p) =>
        c.end_time <= p.start || c.start_time >= p.end
          ? [p]
          : [
              { start: p.start, end: Math.min(p.end, c.start_time) },
              { start: Math.max(p.start, c.end_time), end: p.end },
            ],
      );
    }
    for (const p of pieces) if (p.end - p.start >= MIN_SECONDS) missing.push({ ...planned, start: p.start, end: p.end });
  }

  console.log(`\n=== ${(video.original_filename ?? "").slice(0, 50)} (auto render: ${project?.auto_generate_clips === true})`);
  for (const m of missing) console.log(`  ${fmt(m.start)}-${fmt(m.end)} (${Math.round((m.end - m.start) / 60)} min) [${m.kind}] ${m.activity.slice(0, 110)}`);
  if (!write || missing.length === 0) continue;

  const autoRender = project?.auto_generate_clips === true;
  const rows = plannedVideosAsClips(missing).map((clip) => ({
    project_id: video.project_id,
    video_id: video.id,
    start_time: clip.start,
    end_time: clip.end,
    duration: clip.duration,
    title: censorText(clip.title),
    hook: clip.hook,
    reason: clip.reason,
    scores: clip.scores,
    editing_style: "clean",
    template: "PODCAST_CLEAN",
    edl: { template: "PODCAST_CLEAN", events: [] },
    hashtags: clip.hashtags,
    caption: censorText(clip.caption),
    badges: clip.badges,
    format: "longform",
    longform_edit: false,
    status: autoRender ? "QUEUED" : "SUGGESTED",
  }));
  const { data: inserted, error } = await supabase.from("clips").insert(rows as never).select("id");
  if (error || !inserted) throw new Error(`Inserimento fallito: ${error?.message}`);
  if (autoRender) {
    const { error: jobError } = await supabase.from("render_jobs").insert(inserted.map((c) => ({ clip_id: c.id })));
    if (jobError) throw new Error(`Render non creati: ${jobError.message}`);
  }
  console.log(`  aggiunti ${inserted.length} (${autoRender ? "in coda di render" : "suggeriti, da renderizzare dal sito"})`);
}

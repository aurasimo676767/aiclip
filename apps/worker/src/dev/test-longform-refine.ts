import "dotenv/config";
import fs from "node:fs";
import type { TranscriptSegment } from "@clipforge/shared";
import { supabase } from "../lib/supabase.js";
import { buildVideosFromTimeline, fmt, type TimelineBlock } from "../providers/ai/longform-plan.js";
import { refineVideoBoundaries } from "../providers/ai/longform-boundaries.js";
import { env } from "../env.js";

/**
 * Rifinitura dei confini a partire da una timeline GIÀ SALVATA da test-longform-plan.ts (la mappa
 * non si ripaga): ricostruisce i video con le regole attuali, rifinisce i confini e stampa il
 * transcript attorno a ogni taglio per giudicarlo.
 * Uso: tsx src/dev/test-longform-refine.ts <video_id> <plan.json>
 */
const [videoId, planPath] = process.argv.slice(2);
if (!videoId || !planPath) throw new Error("Uso: tsx src/dev/test-longform-refine.ts <video_id> <plan.json>");

const saved = JSON.parse(fs.readFileSync(planPath, "utf8")) as { plan: { timeline: TimelineBlock[] } };
const { data: transcript } = await supabase.from("transcripts").select("segments,duration_seconds").eq("video_id", videoId).single();
if (!transcript) throw new Error("Transcript mancante");
const segments = transcript.segments as unknown as TranscriptSegment[];

const videos = buildVideosFromTimeline(saved.plan.timeline);
const { videos: refined, usage } = await refineVideoBoundaries(videos, segments, {
  apiKey: env.ANTHROPIC_API_KEY,
  model: env.ANTHROPIC_MODEL_LONGFORM,
  videoDurationSeconds: transcript.duration_seconds,
});

const lineAt = (t: number) => segments.find((s) => s.start <= t + 0.5 && s.end > t - 0.5);
console.log(`\nUso: ${JSON.stringify(usage)}\n`);
for (const v of refined) {
  const before = videos.find((o) => o.activity === v.activity && o.part === v.part);
  console.log(`${fmt(v.start)}-${fmt(v.end)} (${Math.round((v.end - v.start) / 60)}m) ${v.topic.slice(0, 90)}`);
  if (before) console.log(`   prima: ${fmt(before.start)}-${fmt(before.end)}`);
  console.log(`   INIZIO: ${lineAt(v.start)?.text.slice(0, 150) ?? "-"}`);
  const last = [...segments].reverse().find((s) => s.end <= v.end + 0.5);
  console.log(`   FINE:   ${last?.text.slice(-150) ?? "-"}`);
}

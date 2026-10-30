import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { buildVideosFromTimeline, fmt } from "../providers/ai/longform-plan.js";

/** Che video uscirebbero dalle mappe già salvate, senza spendere. Uso: tsx src/dev/vod-plan-preview.ts [giorni] */
const since = new Date(Date.now() - Number(process.argv[2] ?? 7) * 86400_000).toISOString();
const { data: videos } = await supabase.from("videos").select("original_filename,usage_stats").gte("created_at", since).order("created_at");
for (const v of videos ?? []) {
  const timeline = (v.usage_stats as { longformTimeline?: unknown } | null)?.longformTimeline as Parameters<typeof buildVideosFromTimeline>[0] | { blocks: Parameters<typeof buildVideosFromTimeline>[0] } | undefined;
  if (!timeline) continue;
  const blocks = Array.isArray(timeline) ? timeline : timeline.blocks;
  console.log(`\n=== ${(v.original_filename ?? "").slice(0, 60)}`);
  for (const p of buildVideosFromTimeline(blocks)) console.log(`  ${fmt(p.start)}-${fmt(p.end)} (${Math.round((p.end - p.start) / 60)} min) [${p.kind}] ${p.activity.slice(0, 130)}`);
}

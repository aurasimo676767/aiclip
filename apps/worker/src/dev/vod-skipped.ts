import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Cosa è rimasto fuori dai video di ogni VOD, dalla mappa salvata. Uso: tsx src/dev/vod-skipped.ts [giorni] [minuti minimi] */
const since = new Date(Date.now() - Number(process.argv[2] ?? 7) * 86400_000).toISOString();
const minMinutes = Number(process.argv[3] ?? 2);
const hms = (s: number) => new Date(s * 1000).toISOString().slice(11, 19);
const { data: videos } = await supabase.from("videos").select("id,original_filename,duration_seconds,usage_stats").gte("created_at", since).order("created_at");
for (const v of videos ?? []) {
  const timeline = (v.usage_stats as { longformTimeline?: unknown } | null)?.longformTimeline as Record<string, unknown> | unknown[] | undefined;
  if (!timeline) continue;
  const blocks = (Array.isArray(timeline) ? timeline : ((timeline as { blocks?: unknown[] }).blocks ?? [])) as Array<Record<string, unknown>>;
  const { data: clips } = await supabase.from("clips").select("start_time,end_time,title,format").eq("video_id", v.id).eq("format", "longform").order("start_time");
  console.log(`\n=== ${(v.original_filename ?? "").slice(0, 60)} (${Math.round((v.duration_seconds ?? 0) / 60)} min), blocchi ${blocks.length}`);
  if (blocks[0]) console.log("campi:", Object.keys(blocks[0]).join(","));
  for (const c of clips ?? []) console.log(`  VIDEO ${hms(c.start_time)}-${hms(c.end_time)} ${c.title}`);
  let total = 0;
  for (const b of blocks) {
    const start = Number(b.start ?? b.startSeconds ?? 0);
    const end = Number(b.end ?? b.endSeconds ?? 0);
    const covered = (clips ?? []).reduce((sum, c) => sum + Math.max(0, Math.min(end, c.end_time) - Math.max(start, c.start_time)), 0);
    const out = end - start - covered;
    if (out >= minMinutes * 60) {
      total += out;
      console.log(`  FUORI ${hms(start)}-${hms(end)} (${Math.round(out / 60)} min) [${b.kind}] ${b.activity ?? ""} ${String(b.what ?? "").slice(0, 150)}`);
    }
  }
  console.log(`  totale fuori: ${Math.round(total / 60)} min`);
}

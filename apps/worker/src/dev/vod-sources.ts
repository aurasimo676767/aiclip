import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** I VOD recenti: dove sta il sorgente e quante clip lunghe hanno. Uso: tsx src/dev/vod-sources.ts [giorni] */
const since = new Date(Date.now() - Number(process.argv[2] ?? 7) * 86400_000).toISOString();
const { data } = await supabase.from("videos").select("id,project_id,original_filename,storage_path,source_url,duration_seconds,status,usage_stats").gte("created_at", since).order("created_at");
for (const v of data ?? []) {
  if (!(v.usage_stats as { longformTimeline?: unknown } | null)?.longformTimeline) continue;
  const { data: clips } = await supabase.from("clips").select("status").eq("video_id", v.id).eq("format", "longform");
  console.log(v.id, v.status, (v.original_filename ?? "").slice(0, 28), Math.round((v.duration_seconds ?? 0) / 60) + "min", "storage=" + (v.storage_path ?? "VUOTO"), "clip=" + clips?.length, v.source_url);
}

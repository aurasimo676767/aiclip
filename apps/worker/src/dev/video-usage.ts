import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Costi salvati nei video (usage_stats) degli ultimi giorni. Uso: tsx src/dev/video-usage.ts [giorni] */
const since = new Date(Date.now() - Number(process.argv[2] ?? 10) * 86400_000).toISOString();
const { data } = await supabase.from("videos").select("id,created_at,duration_seconds,original_filename,usage_stats").gte("created_at", since).order("created_at");
for (const v of data ?? []) {
  const u = (v.usage_stats ?? {}) as Record<string, unknown>;
  const flat = Object.fromEntries(Object.entries(u).filter(([k]) => k !== "longformTimeline"));
  console.log(v.created_at.slice(0, 16), Math.round((v.duration_seconds ?? 0) / 60) + "min", (v.original_filename ?? "").slice(0, 30), JSON.stringify(flat).slice(0, 600));
}

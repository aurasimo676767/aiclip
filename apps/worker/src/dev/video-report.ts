import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Clip di un video con stato e render, più costi e tempi. Uso: tsx src/dev/video-report.ts <video_id> */
const id = process.argv[2]!;
const fmt = (t: number) => `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const { data: video } = await supabase.from("videos").select("status,duration_seconds,usage_stats,original_filename").eq("id", id).single();
console.log(video?.original_filename, video?.status, fmt(video?.duration_seconds ?? 0));
console.log("usage:", JSON.stringify(video?.usage_stats));
const { data: clips } = await supabase.from("clips").select("id,start_time,end_time,title,status,format").eq("video_id", id).order("start_time");
for (const c of clips ?? []) {
  const { data: jobs } = await supabase.from("render_jobs").select("status,stage,progress,error_message").eq("clip_id", c.id).order("created_at", { ascending: false }).limit(1);
  const j = jobs?.[0];
  console.log(`${fmt(c.start_time)}-${fmt(c.end_time)} (${Math.round((c.end_time - c.start_time) / 60)}m) [${c.status}] ${c.title}`);
  if (j) console.log(`   render: ${j.status} ${j.stage ?? ""} ${j.progress ?? ""}% ${j.error_message ?? ""}`);
}

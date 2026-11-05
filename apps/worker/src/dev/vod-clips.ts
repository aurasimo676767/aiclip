import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Tutte le clip di un VOD (Shorts e video lunghi) con tempi, stato e titolo. Uso: tsx src/dev/vod-clips.ts <video_id> */
const [videoId] = process.argv.slice(2);
const hms = (s: number) => new Date(s * 1000).toISOString().slice(11, 19);
const { data, error } = await supabase
  .from("clips")
  .select("id,format,status,start_time,end_time,title,longform_edit,created_at")
  .eq("video_id", videoId!)
  .order("start_time");
if (error) throw new Error(error.message);
for (const c of data ?? []) {
  console.log(`${c.id.slice(0, 8)} ${c.format.padEnd(9)} ${String(c.status).padEnd(10)} ${hms(c.start_time)}-${hms(c.end_time)} (${Math.round(c.end_time - c.start_time)}s) ${c.title}`);
}

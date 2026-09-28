import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Clip di un video con stato e durata. Uso: tsx src/dev/video-clips.ts <videoId> */
const { data } = await supabase.from("clips").select("id,status,format,duration,title").eq("video_id", process.argv[2]!).order("start_time");
for (const c of data ?? []) console.log(`${c.id} ${c.status.padEnd(9)} ${c.format.padEnd(8)} ${Math.round(c.duration / 60)} min  ${c.title}`);

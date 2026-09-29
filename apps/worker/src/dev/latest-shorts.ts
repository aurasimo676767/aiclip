import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Ultimi Shorts completati. Uso: tsx src/dev/latest-shorts.ts [n] */
const { data } = await supabase.from("clips").select("id,video_id,title,updated_at,start_time,end_time,edl").eq("format", "short").eq("status", "COMPLETED").order("updated_at", { ascending: false }).limit(Number(process.argv[2] ?? 5));
for (const c of data ?? []) console.log(`${c.updated_at.slice(5, 16)} ${c.id} ${c.video_id.slice(0, 8)} ${Math.round(c.end_time - c.start_time)}s ${c.title}`);

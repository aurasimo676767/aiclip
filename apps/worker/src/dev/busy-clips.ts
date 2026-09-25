import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Clip in coda o in render su tutti i video. Uso: tsx src/dev/busy-clips.ts */
const { data } = await supabase.from("clips").select("id,video_id,status,format,updated_at,title").in("status", ["QUEUED", "RENDERING"]).order("updated_at");
for (const c of data ?? []) console.log(c.status, c.format, c.video_id.slice(0, 8), c.updated_at, (c.title ?? "").slice(0, 60));

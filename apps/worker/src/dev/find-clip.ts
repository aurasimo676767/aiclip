import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Cerca le clip per titolo. Uso: tsx src/dev/find-clip.ts <pezzo di titolo> */
const q = process.argv.slice(2).join(" ");
const { data } = await supabase.from("clips").select("id,video_id,format,start_time,end_time,longform_edit,status,title").ilike("title", `%${q}%`).limit(10);
for (const c of data ?? []) console.log(JSON.stringify(c));

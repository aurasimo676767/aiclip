import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Cerca i video per titolo, con stato e numero di clip. Uso: tsx src/dev/find-video.ts <pezzo di titolo> */
const q = process.argv.slice(2).join(" ");
const { data } = await supabase.from("videos").select("id,status,original_filename,created_at,source_url").ilike("original_filename", `%${q}%`);
for (const v of data ?? []) {
  const { count } = await supabase.from("clips").select("id", { count: "exact", head: true }).eq("video_id", v.id);
  console.log(`${v.created_at.slice(0, 10)} ${v.status} clip:${count} ${v.id} ${v.original_filename} ${v.source_url ?? ""}`);
}
if (!data?.length) console.log("nessun video con questo titolo");

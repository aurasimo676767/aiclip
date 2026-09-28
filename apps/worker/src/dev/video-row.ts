import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Dati principali di un video. Uso: tsx src/dev/video-row.ts <videoId> */
const { data } = await supabase.from("videos").select("id,status,source_url,duration_seconds,original_filename,streamer_name,updated_at").eq("id", process.argv[2]!).single();
console.log(JSON.stringify(data));

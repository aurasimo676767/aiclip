import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Stato di un video in pipeline. Uso: tsx src/dev/video-status.ts <video_id> */
const { data } = await supabase.from("videos").select("status,storage_path,error_message,updated_at").eq("id", process.argv[2]!).single();
console.log(JSON.stringify(data));

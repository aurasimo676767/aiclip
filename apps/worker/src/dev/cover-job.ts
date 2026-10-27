import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Tutto di una copertina generata e della sua clip. Uso: tsx src/dev/cover-job.ts <jobId> */
const { data, error } = await supabase.from("thumbnail_jobs").select("*").eq("id", process.argv[2]!).single();
if (error) throw new Error(error.message);
console.log(JSON.stringify(data, null, 1));
const { data: clip } = await supabase.from("clips").select("id,title,format,duration,video_id,project_id").eq("id", data.clip_id).single();
console.log(JSON.stringify(clip));

import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Stato di una clip e dei suoi render. Uso: tsx src/dev/clip-state.ts <clipId> */
const id = process.argv[2]!;
const { data: clip } = await supabase.from("clips").select("id,title,status,error_message,output_video_path,thumbnail_path,preview_video_path,longform_edit,updated_at").eq("id", id).single();
console.log(JSON.stringify(clip, null, 1));
const { data: jobs } = await supabase.from("render_jobs").select("*").eq("clip_id", id).order("created_at", { ascending: false }).limit(5);
for (const j of jobs ?? []) console.log(JSON.stringify(j));

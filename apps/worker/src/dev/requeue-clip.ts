import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Rimette in render una clip anche se è FAILED (regenerate-clip.ts vuole COMPLETED). Uso: tsx src/dev/requeue-clip.ts <clipId> */
const clipId = process.argv[2]!;
const { data: clip } = await supabase.from("clips").update({ status: "QUEUED", error_message: null }).eq("id", clipId).in("status", ["COMPLETED", "FAILED"]).select("id,title,longform_edit,longform_keep_games").maybeSingle();
if (!clip) throw new Error("La clip non è COMPLETED né FAILED (già in lavorazione?)");
const { error } = await supabase.from("render_jobs").insert({ clip_id: clipId });
if (error) throw new Error(`Render job non creato: ${error.message}`);
console.log("in coda:", JSON.stringify(clip));

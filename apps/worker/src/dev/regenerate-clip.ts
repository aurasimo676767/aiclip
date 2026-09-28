import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Rimette in render una clip già completata, come "Rigenera clip" per un long-form (template invariato).
 * Uso: tsx src/dev/regenerate-clip.ts <clipId>
 */
const clipId = process.argv[2]!;
const { data: queued } = await supabase.from("clips").update({ status: "QUEUED", error_message: null }).eq("id", clipId).eq("status", "COMPLETED").select("id").maybeSingle();
if (!queued) throw new Error("La clip non è COMPLETED (già in lavorazione?)");
const { error } = await supabase.from("render_jobs").insert({ clip_id: clipId });
if (error) {
  await supabase.from("clips").update({ status: "COMPLETED" }).eq("id", clipId).eq("status", "QUEUED");
  throw new Error(`Render job non creato: ${error.message}`);
}
console.log("in coda");

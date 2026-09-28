import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Annulla il render in coda o in corso di una o più clip, come il pulsante "Annulla" del sito
 * (apps/web/src/app/api/clips/[id]/cancel-render): render_job e clip FAILED + cancel_requested.
 * Uso: tsx src/dev/cancel-render.ts <clipId> [clipId...]
 */
const CANCEL_MESSAGE = "Annullato dall'utente";
for (const clipId of process.argv.slice(2)) {
  const { data: job } = await supabase
    .from("render_jobs")
    .select("id")
    .eq("clip_id", clipId)
    .in("status", ["PENDING", "RENDERING"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!job) {
    console.log(`${clipId}: nessun render in corso`);
    continue;
  }
  await supabase.from("render_jobs").update({ status: "FAILED", error_message: CANCEL_MESSAGE, cancel_requested: true, completed_at: new Date().toISOString() }).eq("id", job.id);
  await supabase.from("clips").update({ status: "FAILED", error_message: CANCEL_MESSAGE }).eq("id", clipId);
  console.log(`${clipId}: annullato`);
}

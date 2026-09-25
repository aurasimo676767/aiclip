import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Segna come FAILED le clip rimaste "in render"/"in coda" da più di un giorno (render morti con un
 * crash vecchio): tengono acceso all'infinito l'aggiornamento automatico del sito.
 * Uso: tsx src/dev/fail-stuck-clips.ts
 */
const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const { data: stuck } = await supabase.from("clips").select("id,title,status,updated_at").in("status", ["QUEUED", "RENDERING"]).lt("updated_at", dayAgo);
for (const c of stuck ?? []) {
  await supabase.from("render_jobs").update({ status: "FAILED", error_message: "Render rimasto appeso, chiuso a mano" }).eq("clip_id", c.id).in("status", ["PENDING", "RENDERING"]);
  const { error } = await supabase.from("clips").update({ status: "FAILED" }).eq("id", c.id);
  console.log(error ? `Errore ${c.id}: ${error.message}` : `FAILED: ${c.title} (fermo dal ${c.updated_at.slice(0, 10)})`);
}
if (!stuck?.length) console.log("Nessuna clip appesa");

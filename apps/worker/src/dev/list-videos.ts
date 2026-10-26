import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Elenco dei video (gratis, sola lettura): stato, durata, sorgente ancora su storage o no. */
const { data, error } = await supabase.from("videos").select("id, original_filename, source_url, duration_seconds, status, storage_path, streamer_login, created_at").order("created_at", { ascending: false }).limit(40);
if (error) throw error;
for (const v of data ?? []) {
  console.log(`${v.id} ${v.status.padEnd(9)} ${String(Math.round(v.duration_seconds ?? 0)).padStart(6)}s sorgente:${v.storage_path ? "sì" : "no"} ${v.streamer_login ?? ""} ${(v.original_filename ?? "").slice(0, 50)} ${v.source_url ?? ""}`);
}

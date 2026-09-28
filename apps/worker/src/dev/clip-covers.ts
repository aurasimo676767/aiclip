import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Tutte le copertine generate per una clip, dalla più recente. Uso: tsx src/dev/clip-covers.ts <clipId> */
const { data, error } = await supabase.from("thumbnail_jobs").select("*").eq("clip_id", process.argv[2]!).order("created_at", { ascending: false });
if (error) throw new Error(error.message);
for (const j of data ?? []) {
  const { id, status, created_at, result_storage_path, cover_text, error_message } = j as Record<string, unknown>;
  console.log(JSON.stringify({ id, status, created_at, result_storage_path, cover_text, error_message }));
}

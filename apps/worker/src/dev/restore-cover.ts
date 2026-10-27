import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Rimette sul sito una copertina già fatta: il sito mostra l'ultima per data, quindi le si dà la data di
 * adesso (le altre restano salvate). Uso: tsx src/dev/restore-cover.ts <jobId>
 */
const id = process.argv[2]!;
const { data, error } = await supabase
  .from("thumbnail_jobs")
  .update({ created_at: new Date().toISOString() })
  .eq("id", id)
  .eq("status", "COMPLETED")
  .select("id,clip_id,created_at,result_storage_path")
  .single();
if (error) throw new Error(error.message);
console.log(JSON.stringify(data));

import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Ultime copertine con istruzioni e clip, per ritrovare quella da rimettere. Uso: tsx src/dev/last-covers.ts [quante] */
const { data, error } = await supabase
  .from("thumbnail_jobs")
  .select("id,clip_id,status,created_at,result_storage_path,cover_instructions,error_message")
  .order("created_at", { ascending: false })
  .limit(Number(process.argv[2] ?? 10));
if (error) throw new Error(error.message);
for (const j of data ?? []) console.log(JSON.stringify(j));

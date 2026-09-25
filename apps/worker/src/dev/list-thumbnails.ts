import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Ultime copertine generate, con lo stato e dove stanno. Uso: tsx src/dev/list-thumbnails.ts */
const { data } = await supabase.from("thumbnail_jobs").select("id,status,result_storage_path,error_message,created_at").order("created_at", { ascending: false }).limit(8);
for (const j of data ?? []) console.log(j.created_at.slice(0, 10), j.status, j.result_storage_path ?? j.error_message ?? "");

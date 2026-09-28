import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Stampa la riga di una clip e i job di pubblicazione collegati. Uso: tsx src/dev/clip-row.ts <clipId> */
const id = process.argv[2]!;
const { data } = await supabase.from("clips").select("*").eq("id", id).single();
console.log(JSON.stringify(data, null, 1).slice(0, 3000));
for (const table of ["publish_jobs", "publications", "youtube_uploads"]) {
  const { data: rows, error } = await supabase.from(table).select("*").eq("clip_id", id);
  if (!error) console.log(table, JSON.stringify(rows, null, 1).slice(0, 2000));
}

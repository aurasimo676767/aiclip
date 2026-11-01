import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { deleteVideoSourceEverywhere } from "../lib/cleanup-source.js";

/**
 * Come il tasto "Elimina sorgente" del sito, per tutti i video che hanno ancora il sorgente su R2
 * (R2 + cache sul PC). Le clip già renderizzate restano. Uso: tsx src/dev/delete-all-sources.ts --si
 */
if (!process.argv.includes("--si")) throw new Error("Cancella per sempre i sorgenti: rilancia con --si");
const { data: videos, error } = await supabase.from("videos").select("id,original_filename").not("storage_path", "is", null);
if (error) throw new Error(error.message);
for (const v of videos ?? []) {
  await deleteVideoSourceEverywhere(v.id);
  const { data: after } = await supabase.from("videos").select("storage_path").eq("id", v.id).single();
  console.log(after?.storage_path ? "NON cancellato" : "cancellato", v.id, (v.original_filename ?? "").slice(0, 40));
}

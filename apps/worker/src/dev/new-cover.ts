import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Fa partire una copertina nuova come il pulsante "Rigenera" del sito (stessa riga in thumbnail_jobs,
 * compare nel sito). Uso: tsx src/dev/new-cover.ts <clipId> <PERSONE,separate,da,virgola> <scritta> <file con le istruzioni>
 */
import fs from "node:fs";

const [clipId, people, text, instructionsFile] = process.argv.slice(2);
const instructions = fs.readFileSync(instructionsFile!, "utf8").trim();
if (instructions.length > 1000) throw new Error(`Istruzioni troppo lunghe per il sito: ${instructions.length} caratteri (max 1000)`);
const { data, error } = await supabase
  .from("thumbnail_jobs")
  .insert({ clip_id: clipId!, cover_people: people!.split(",").map((p) => p.trim().toUpperCase()), cover_text: text!.toUpperCase(), cover_instructions: instructions })
  .select("id")
  .single();
if (error) throw new Error(error.message);
console.log("Copertina avviata:", data.id);

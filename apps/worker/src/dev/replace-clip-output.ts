import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";

/**
 * Mette un video già renderizzato in locale come video di una clip, senza rifare il render. Il file
 * va su un percorso NUOVO: quello vecchio resta nello storage, così si può tornare indietro
 * rimettendo il percorso stampato qui sotto.
 * Uso: tsx src/dev/replace-clip-output.ts <clipId> <file.mp4> <suffisso>
 */
const [clipId, file, suffix] = process.argv.slice(2);
if (!clipId || !file || !suffix) throw new Error("Uso: tsx src/dev/replace-clip-output.ts <clipId> <file.mp4> <suffisso>");
const { data: clip, error } = await supabase.from("clips").select("project_id,output_video_path").eq("id", clipId).single();
if (error || !clip) throw new Error(`Clip non trovata: ${error?.message}`);
const newPath = `clips/${clip.project_id}/${clipId}-${suffix}.mp4`;
console.log(JSON.stringify({ vecchio: clip.output_video_path, nuovo: newPath }));
await storageProvider.uploadFile(file, newPath, "video/mp4");
const { error: updateError } = await supabase.from("clips").update({ output_video_path: newPath, longform_edit: true }).eq("id", clipId);
if (updateError) throw new Error(updateError.message);
console.log("fatto");

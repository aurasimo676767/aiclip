import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Toglie una clip SOLO se è vuota (durata < 1s) e mai renderizzata. Uso: tsx src/dev/remove-empty-clip.ts <clip_id> */
const id = process.argv[2]!;
const { data: clip } = await supabase.from("clips").select("id,duration,status,title").eq("id", id).single();
if (!clip || clip.duration >= 1 || clip.status !== "SUGGESTED") throw new Error(`Non è una clip vuota non renderizzata: ${JSON.stringify(clip)}`);
const { error } = await supabase.from("clips").delete().eq("id", id);
console.log(error ? `Errore: ${error.message}` : `Tolta la clip vuota "${clip.title}"`);

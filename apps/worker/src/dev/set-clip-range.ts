import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Sposta inizio e fine di un video lungo (secondi del VOD), e volendo il titolo provvisorio. Poi va
 * rifatto il render (regenerate-clip.ts). Rifiuta le clip già pubblicate o in lavorazione.
 * Uso: tsx src/dev/set-clip-range.ts <clipId> <inizio> <fine> [titolo]
 */
const [clipId, start, end, title] = process.argv.slice(2);
const from = Number(start);
const to = Number(end);
if (!(to > from)) throw new Error("La fine deve venire dopo l'inizio");
const { data: published } = await supabase.from("youtube_publish_jobs").select("id").eq("clip_id", clipId!).eq("status", "COMPLETED");
if (published?.length) throw new Error("La clip è già pubblicata su YouTube: non la tocco");
const { data, error } = await supabase
  .from("clips")
  .update({ start_time: from, end_time: to, duration: to - from, ...(title ? { title } : {}) })
  .eq("id", clipId!)
  .in("status", ["SUGGESTED", "COMPLETED", "FAILED"])
  .select("id,start_time,end_time,title")
  .maybeSingle();
if (error) throw new Error(error.message);
if (!data) throw new Error("Clip non trovata o in lavorazione");
console.log("Aggiornata:", JSON.stringify(data));

import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Rimette in render TUTTI gli Shorts di un video (completati, falliti o annullati), in ordine di
 * tempo nel video, come "Renderizza" dal sito. Le clip già in coda o in lavorazione si saltano.
 * Uso: tsx src/dev/rerender-video-shorts.ts <videoId>
 */
const videoId = process.argv[2]!;
const { data: clips, error } = await supabase
  .from("clips")
  .select("id, title, status, format")
  .eq("video_id", videoId)
  .in("status", ["COMPLETED", "FAILED"])
  .order("start_time", { ascending: true });
if (error) throw error;
const shorts = (clips ?? []).filter((c) => c.format !== "longform");
for (const clip of shorts) {
  const { error: jobError } = await supabase.from("render_jobs").insert({ clip_id: clip.id });
  if (jobError) {
    console.log(`${clip.id}: render job non creato (${jobError.message})`);
    continue;
  }
  await supabase.from("clips").update({ status: "QUEUED", error_message: null }).eq("id", clip.id);
  console.log(`in coda: ${clip.title}`);
}
console.log(`totale: ${shorts.length}`);

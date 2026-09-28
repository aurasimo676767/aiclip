import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Righe del transcript fra due secondi, con inizio e fine (secondi del VOD). Uso: tsx src/dev/segs-at.ts <video_id> <da> <a> */
const [id, a, b] = process.argv.slice(2);
const { data } = await supabase.from("transcripts").select("segments").eq("video_id", id!).single();
for (const s of data!.segments as Array<{ start: number; end: number; text: string }>) {
  if (s.end > Number(a) && s.start < Number(b)) console.log(`${s.start.toFixed(1)}-${s.end.toFixed(1)} ${s.text.trim().slice(0, 160)}`);
}

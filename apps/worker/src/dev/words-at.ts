import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Parole (con i tempi) del transcript fra due secondi. Uso: tsx src/dev/words-at.ts <video_id> <da> <a> */
const [id, a, b] = process.argv.slice(2);
const { data } = await supabase.from("transcripts").select("segments").eq("video_id", id!).single();
const from = Number(a), to = Number(b);
for (const s of (data!.segments as Array<{ words?: Array<{ word: string; start: number; end: number }> }>)) {
  for (const w of s.words ?? []) if (w.start >= from && w.start <= to) process.stdout.write(`${w.start.toFixed(1)} ${w.word.trim()} | `);
}
console.log();

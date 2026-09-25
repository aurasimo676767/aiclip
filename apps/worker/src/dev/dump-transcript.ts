import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Stampa le righe del transcript fra due secondi. Uso: tsx src/dev/dump-transcript.ts <video_id> <da> <a> */
const [videoId, from, to] = process.argv.slice(2);
const { data } = await supabase.from("transcripts").select("segments").eq("video_id", videoId!).single();
const segs = (data!.segments as Array<{ start: number; text: string }>).filter((s) => s.start >= Number(from) && s.start < Number(to));
const fmt = (t: number) => `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
for (const s of segs) console.log(`[${Math.round(s.start)} ${fmt(s.start)}] ${s.text}`);

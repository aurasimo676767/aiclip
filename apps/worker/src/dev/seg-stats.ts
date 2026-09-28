import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Statistiche dei segmenti del transcript (durata, parole con tempi). Uso: tsx src/dev/seg-stats.ts <video_id> */
const { data } = await supabase.from("transcripts").select("segments").eq("video_id", process.argv[2]!).single();
const segs = data!.segments as Array<{ start: number; end: number; words?: Array<Record<string, unknown>> }>;
const durs = segs.map((s) => s.end - s.start).sort((a, b) => a - b);
console.log(JSON.stringify({ segmenti: segs.length, durataMediana: durs[Math.floor(durs.length / 2)], max: durs[durs.length - 1], conParole: segs.filter((s) => (s.words?.length ?? 0) > 0).length, esempioParola: segs.find((s) => s.words?.length)?.words?.[0] }));

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import type { RankedClip, TranscriptSegment } from "@clipforge/shared";
import { sanitizeShortClips } from "../pipeline/short-clip-boundaries.js";

/**
 * Verifica la correzione dei confini su clip Shorts REALI già in DB (non su dati inventati):
 * stampa i confini prima e dopo, e cosa è stato scartato. Uso: tsx src/dev/test-short-boundaries.ts <videoId>
 */
const VIDEO_ID = process.argv[2] ?? "02ab74f3-2c07-4bdd-84a3-6e8ee8ab4892";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const { data: transcript } = await supabase.from("transcripts").select("segments").eq("video_id", VIDEO_ID).single();
const { data: clips } = await supabase
  .from("clips")
  .select("start_time, end_time, duration, hook, title, scores, edl")
  .eq("video_id", VIDEO_ID)
  .eq("format", "short")
  .order("start_time");

const segments = transcript!.segments as TranscriptSegment[];
const ranked: RankedClip[] = (clips ?? []).map((c) => ({
  start: c.start_time,
  end: c.end_time,
  duration: c.duration,
  hook: c.hook,
  title: c.title,
  reason: "",
  scores: c.scores as RankedClip["scores"],
  editing_style: "clean",
  edl: (c.edl as RankedClip["edl"]) ?? { template: "PODCAST_CLEAN", events: [] },
  hashtags: [],
  badges: [],
  caption: "",
}));

const textBetween = (start: number, end: number): string =>
  segments
    .filter((s) => s.start >= start && s.end <= end)
    .map((s) => s.text.trim())
    .join(" ")
    .slice(0, 140);

console.log("=== PRIMA ===");
for (const c of ranked) {
  console.log(`${c.start.toFixed(1)}-${c.end.toFixed(1)} (${c.duration.toFixed(1)}s) | ${c.title}`);
  console.log(`   testo: ${textBetween(c.start, c.end)}`);
}

const result = sanitizeShortClips(ranked, segments, VIDEO_ID);

console.log("");
console.log("=== DOPO ===");
for (const c of result) {
  console.log(`${c.start.toFixed(1)}-${c.end.toFixed(1)} (${c.duration.toFixed(1)}s) | ${c.title}`);
  console.log(`   testo: ${textBetween(c.start, c.end)}`);
}
console.log("");
console.log(`Clip: ${ranked.length} -> ${result.length}`);

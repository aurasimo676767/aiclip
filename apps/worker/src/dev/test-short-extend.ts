import "dotenv/config";
import type { RankedClip, TranscriptSegment } from "@clipforge/shared";
import { supabase } from "../lib/supabase.js";
import { sanitizeShortClips } from "../pipeline/short-clip-boundaries.js";

// Prova gratuita dell'allungamento delle clip troppo corte, sulle 3 buttate il 2026-10-25.
const videoId = "057c4abd-69cc-4136-8576-23f1160aed5c";
const { data } = await supabase.from("transcripts").select("segments").eq("video_id", videoId).single();
const segments = data!.segments as TranscriptSegment[];
const scores = { hook: 70, retention: 70, emotion: 70, clarity: 70, payoff: 70, virality: 70 };
const make = (start: number, end: number, hook: string) =>
  ({ start, end, duration: end - start, hook, scores, edl: { template: "STREAMER", events: [] } }) as unknown as RankedClip;
const clips = [make(333.7, 344.9, "Do you want to touch?"), make(479.9, 489, "Cioè, tu mi hai dato un potere a me"), make(614.7, 624.4, "A")];
for (const c of sanitizeShortClips(clips, segments, videoId)) {
  const text = segments.filter((s) => s.end > c.start && s.start < c.end).map((s) => s.text.trim()).join(" ");
  console.log(`${c.start.toFixed(1)}-${c.end.toFixed(1)} (${c.duration.toFixed(1)} s): ${text.slice(0, 300)}`);
}

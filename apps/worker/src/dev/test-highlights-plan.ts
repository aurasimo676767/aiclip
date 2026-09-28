import "dotenv/config";
import type { TranscriptSegment } from "@clipforge/shared";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";
import { planHighlights } from "../providers/ai/longform-highlights.js";

/**
 * Solo il piano del montaggio "da YouTuber" di una clip, senza render: per capire perché un
 * montaggio non è partito. A PAGAMENTO (~5-6 centesimi l'ora). Uso: tsx src/dev/test-highlights-plan.ts <clipId>
 */
const { data: clip } = await supabase.from("clips").select("video_id,start_time,end_time,title").eq("id", process.argv[2]!).single();
const { data: tr } = await supabase.from("transcripts").select("segments").eq("video_id", clip!.video_id).single();
const duration = clip!.end_time - clip!.start_time;
const segments = (tr!.segments as TranscriptSegment[])
  .map((s) => ({ ...s, start: s.start - clip!.start_time, end: s.end - clip!.start_time }))
  .filter((s) => s.end > 0 && s.start < duration);
const plan = await planHighlights({ title: clip!.title, durationSeconds: duration, segments, loudMoments: [] }, { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL_LONGFORM_EDIT });
console.log(plan ? JSON.stringify({ tratti: plan.keep.length, tenuti: Math.round(plan.keep.reduce((a, r) => a + r.end - r.start, 0)), intro: plan.intro.length, primiPiani: plan.closeups.length, cambi: plan.topicChanges.length }) : "PIANO NULLO");

import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import type { TranscriptSegment } from "@clipforge/shared";
import { detectLongformCandidates } from "../providers/ai/longform-candidates.js";
import { rankLongformClips } from "../providers/ai/longform-ranking.js";
import { segmentsInWindow } from "../providers/ai/transcript-formatting.js";
import { env } from "../env.js";

const VIDEO_ID = "4d161f37-1c8d-4131-8683-cccac8c98f9f";

async function main() {
  const { data: transcript, error } = await supabase
    .from("transcripts")
    .select("segments,duration_seconds")
    .eq("video_id", VIDEO_ID)
    .single();
  if (error || !transcript) throw new Error(`Transcript non trovato: ${error?.message}`);

  const segments = transcript.segments as unknown as TranscriptSegment[];

  // Finestra che dovrebbe contenere l'intero gioco "Indovina Chi" (250-290min circa).
  const windowStart = 245 * 60;
  const windowEnd = 290 * 60;
  const windowSegments = segmentsInWindow(segments, windowStart, windowEnd);
  console.log(`Finestra ${windowStart / 60}min-${windowEnd / 60}min: ${windowSegments.length} segmenti nel transcript salvato.`);
  console.log(`Ultimo segmento della finestra: [${(windowSegments[windowSegments.length - 1]!.start / 60).toFixed(1)}min] ${windowSegments[windowSegments.length - 1]!.text}\n`);

  // Passo la finestra as-is a detectLongformCandidates riusando la sua stessa logica di
  // finestratura (le passo l'intero transcript, così userà windows reali come in produzione).
  const { candidates, usage: candidatesUsage } = await detectLongformCandidates(segments, {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL_CHEAP,
    videoTitle: "test",
    videoDurationSeconds: transcript.duration_seconds,
  });

  console.log(`\n=== Candidati totali generati dal passaggio economico (${candidates.length}) — uso: ${JSON.stringify(candidatesUsage)} ===`);
  for (const c of candidates) {
    console.log(`[${(c.start / 60).toFixed(1)}min -> ${(c.end / 60).toFixed(1)}min] (${((c.end - c.start) / 60).toFixed(1)}min) ${c.topic}`);
  }

  const { clips: ranked, usage: rankingUsage } = await rankLongformClips(candidates, segments, {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL_LONGFORM,
    videoTitle: "🚨MINIMARATONA🚨 REACTION ROMA FAMILY FEUD INDOVINA CHI RUN DI SIFU FORTNITE PEGGLE",
    streamerName: "Tumblurr",
  });

  console.log(`\n=== Clip finali dopo il ranking (${ranked.length}) — uso: ${JSON.stringify(rankingUsage)} ===`);
  for (const c of ranked) {
    console.log(`\n[${(c.start / 60).toFixed(1)}min -> ${(c.end / 60).toFixed(1)}min] (${((c.end - c.start) / 60).toFixed(1)}min)`);
    console.log(`  ${JSON.stringify(c, null, 2).slice(0, 500)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

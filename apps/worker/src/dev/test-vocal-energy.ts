import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import type { TranscriptSegment } from "@clipforge/shared";
import { detectLoudMoments } from "../pipeline/vocal-energy.js";

/**
 * Verifica il rilevamento delle urla su un file reale, incrociandolo col transcript del video
 * (serve a scartare alert/musica: contano solo i picchi in cui qualcuno parla davvero).
 * Uso: tsx src/dev/test-vocal-energy.ts <path> <videoId>
 */
const mediaPath = process.argv[2];
const videoId = process.argv[3];
if (!mediaPath || !videoId) {
  console.error("Uso: tsx src/dev/test-vocal-energy.ts <path> <videoId>");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const { data: transcript } = await supabase.from("transcripts").select("segments").eq("video_id", videoId).single();
const segments = (transcript?.segments ?? []) as TranscriptSegment[];

const started = Date.now();
const moments = await detectLoudMoments(mediaPath, segments);
console.log(`Analisi in ${((Date.now() - started) / 1000).toFixed(1)}s — ${moments.length} momenti forti`);
for (const m of moments.slice(0, 20)) {
  console.log(`  ${m.start.toFixed(0)}s - ${m.end.toFixed(0)}s  (+${m.aboveBaselineDb.toFixed(1)} dB)`);
}

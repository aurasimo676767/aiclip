import "dotenv/config";
import { getAnthropicClient } from "../providers/ai/anthropic-client.js";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";

/**
 * Annulla i batch Anthropic in coda da più di N minuti, così il worker (createMessage) rifà subito
 * la chiamata normale senza doverlo riavviare. Si ferma quando il video non è più in analisi.
 * Uso: tsx src/dev/batch-guard.ts <video_id> [minuti=20]
 */
const [videoId, minutes = "20"] = process.argv.slice(2);
const maxMs = Number(minutes) * 60_000;
const client = getAnthropicClient(env.ANTHROPIC_API_KEY);
for (;;) {
  const page = await client.beta.messages.batches.list({ limit: 10 });
  for (const b of page.data) {
    if (b.processing_status !== "in_progress") continue;
    const age = Date.now() - new Date(b.created_at).getTime();
    if (age > maxMs) {
      await client.beta.messages.batches.cancel(b.id);
      console.log(`annullato ${b.id} dopo ${Math.round(age / 60000)} min`);
    }
  }
  const { data } = await supabase.from("videos").select("status").eq("id", videoId!).single();
  if (!data || !["ANALYZING", "CLIP_SELECTION"].includes(data.status)) {
    console.log(`video ${data?.status ?? "sparito"}: fine`);
    break;
  }
  await new Promise((r) => setTimeout(r, 30_000));
}

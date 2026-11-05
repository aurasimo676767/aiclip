import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { fmt } from "../providers/ai/longform-plan.js";

/** La mappa salvata di un VOD, blocco per blocco (gratis). Uso: tsx src/dev/vod-timeline.ts <video_id> */
const [videoId] = process.argv.slice(2);
const { data } = await supabase.from("videos").select("usage_stats").eq("id", videoId!).single();
const timeline = (data?.usage_stats as { longformTimeline?: unknown } | null)?.longformTimeline as Array<Record<string, unknown>> | { blocks: Array<Record<string, unknown>> } | undefined;
const blocks = Array.isArray(timeline) ? timeline : (timeline?.blocks ?? []);
for (const b of blocks) console.log(`${fmt(Number(b.start))}-${fmt(Number(b.end))} [${b.kind}] ${b.activity} — ${String(b.what).slice(0, 140)}`);

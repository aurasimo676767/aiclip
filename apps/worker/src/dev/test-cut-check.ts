import "dotenv/config";
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";
import { checkCuts, type CutVideo } from "../providers/ai/longform-cut-check.js";
import { fmt } from "../providers/ai/longform-plan.js";

/**
 * Prova del controllo tagli a schermo su video scelti a mano (A PAGAMENTO, pochi centesimi; le
 * risposte restano in cache su disco). Il sorgente deve essere in tmp/source-cache.
 * Uso: tsx src/dev/test-cut-check.ts <video_id> "<inizio>-<fine>|<attività>|<game|reaction|talk>" ...
 * (video consecutivi con fine = inizio sono un confine condiviso)
 */
const [videoId, ...specs] = process.argv.slice(2);
const { data: video } = await supabase.from("videos").select("storage_path,duration_seconds").eq("id", videoId!).single();
const { data: t } = await supabase.from("transcripts").select("segments").eq("video_id", videoId!).single();
const hash = crypto.createHash("sha256").update(video!.storage_path!).digest("hex").slice(0, 16);
const fs = await import("node:fs");
const source = ["mp4", "ts", "mkv"].map((e) => `tmp/source-cache/${hash}.${e}`).find((p) => fs.existsSync(p));
if (!source) throw new Error("Sorgente non in cache");
const videos: CutVideo[] = specs.map((s) => {
  const [range, activity, kind] = s.split("|");
  const [start, end] = range!.split("-").map(Number);
  return { start: start!, end: end!, activity: activity!, kind: (kind ?? "game") as CutVideo["kind"] };
});
const result = await checkCuts(videos, {
  apiKey: env.ANTHROPIC_API_KEY,
  model: env.ANTHROPIC_MODEL_LONGFORM_CUT_CHECK,
  openaiApiKey: env.OPENAI_API_KEY,
  sourceVideoPath: source,
  segments: t!.segments as never,
  videoDurationSeconds: video!.duration_seconds ?? 0,
});
for (const [i, v] of result.videos.entries()) console.log(`${videos[i]!.activity}: ${fmt(videos[i]!.start)}-${fmt(videos[i]!.end)}  ->  ${fmt(v.start)}-${fmt(v.end)}`);
console.log(result.changes.join("\n"));

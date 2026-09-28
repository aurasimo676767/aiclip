import "dotenv/config";
import path from "node:path";
import fsp from "node:fs/promises";
import type { TranscriptSegment } from "@clipforge/shared";
import { probeVideo } from "../lib/ffmpeg.js";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";
import { planLongformEdit, renderEditedLongform, type HighlightsInput } from "../render/longform-auto-edit.js";

/**
 * Prova il montaggio long-form su un pezzo di un sorgente locale.
 * Uso: tsx src/dev/test-longform-edit.ts <sorgente> <inizio s> <fine s> <out.mp4> [intro=a-b,c-d] [ai=<videoId>]
 * - intro=...: intro finta (secondi dall'inizio del pezzo) per provare il render, GRATIS;
 * - ai=<videoId>: piano "da YouTuber" vero con la trascrizione del video, A PAGAMENTO (chiedere a simo).
 */
const [source, startArg, endArg, outArg, ...opts] = process.argv.slice(2);
if (!source || !startArg || !endArg || !outArg) throw new Error("Uso: tsx src/dev/test-longform-edit.ts <sorgente> <inizio> <fine> <out.mp4> [intro=a-b,c-d] [ai=<videoId>]");
const start = Number(startArg);
const end = Number(endArg);
const opt = (k: string) => opts.find((o) => o.startsWith(`${k}=`))?.slice(k.length + 1);
let highlights: HighlightsInput | undefined;
const aiVideo = opt("ai");
if (aiVideo) {
  const { data } = await supabase.from("transcripts").select("segments").eq("video_id", aiVideo).single();
  const title = opt("title") ?? "video";
  highlights = { title, segments: data!.segments as TranscriptSegment[], apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL_LONGFORM_EDIT, openaiApiKey: env.OPENAI_API_KEY };
}
const probe = await probeVideo(source);
const t0 = Date.now();
const plan = await planLongformEdit({ sourceVideoPath: source, sourceWidth: probe.width!, sourceHeight: probe.height!, start, end, faceTracker: new ReactionCamFaceTracker(), highlights });
const fakeIntro = opt("intro");
if (fakeIntro) plan.intro = fakeIntro.split(",").map((r) => { const [a, b] = r.split("-").map(Number); return { start: a!, end: b! }; });
const t1 = Date.now();
const workDir = path.join(path.dirname(path.resolve(outArg)), "edit-work");
await fsp.mkdir(workDir, { recursive: true });
await fsp.writeFile(path.resolve(outArg) + ".plan.json", JSON.stringify(plan, null, 1));
await renderEditedLongform({ sourceVideoPath: source, start, end, plan, workDir, outputPath: path.resolve(outArg) });
const t2 = Date.now();
console.log(JSON.stringify({ analisiSec: Math.round((t1 - t0) / 1000), renderSec: Math.round((t2 - t1) / 1000), durataIn: end - start, durataOut: Math.round(plan.outputDuration), tratti: plan.keep.length, intro: plan.intro, stacchi: plan.punches.length }));

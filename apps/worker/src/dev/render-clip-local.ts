import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TEMPLATES, type RankedClip, type TemplateName, type TranscriptSegment } from "@clipforge/shared";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";
import { getOrDownloadSourceFile } from "../lib/source-download-cache.js";
import { renderClip } from "../render/render-clip.js";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";

/**
 * Renderizza una clip VERA (dal database) esattamente come il job di produzione, ma solo in
 * locale: niente upload, niente scritture nel database, nessuna chiamata a servizi a pagamento.
 * Serve a confrontare il render nuovo con quello già pubblicato.
 * Uso: tsx src/dev/render-clip-local.ts <clip_id> <out.mp4>
 */
const [clipId, outArg] = process.argv.slice(2);
if (!clipId || !outArg) throw new Error("Uso: tsx src/dev/render-clip-local.ts <clip_id> <out.mp4>");

const { data: clipRow, error } = await supabase.from("clips").select("*").eq("id", clipId).single();
if (error || !clipRow) throw new Error(`Clip non trovata: ${error?.message}`);
const { data: videoRow } = await supabase.from("videos").select("storage_path").eq("id", clipRow.video_id).single();
if (!videoRow?.storage_path) throw new Error("Il video della clip non ha una sorgente su storage");
const { data: transcriptRow } = await supabase.from("transcripts").select("segments").eq("video_id", clipRow.video_id).single();
if (!transcriptRow) throw new Error("Transcript mancante");

const sourcePath = await getOrDownloadSourceFile(storageProvider, videoRow.storage_path);
const template = DEFAULT_TEMPLATES[(clipRow.template as TemplateName) in DEFAULT_TEMPLATES ? (clipRow.template as TemplateName) : "PODCAST_CLEAN"];
const clip: RankedClip = {
  start: clipRow.start_time,
  end: clipRow.end_time,
  duration: clipRow.duration,
  hook: clipRow.hook,
  title: clipRow.title,
  reason: clipRow.reason,
  scores: clipRow.scores as RankedClip["scores"],
  editing_style: clipRow.editing_style as RankedClip["editing_style"],
  edl: clipRow.edl as RankedClip["edl"],
  hashtags: (clipRow.hashtags as string[] | null) ?? [],
  caption: clipRow.caption,
  badges: (clipRow.badges as RankedClip["badges"] | null) ?? [],
};

const outPath = path.resolve(outArg);
const workDir = path.join(path.dirname(outPath), `work-${clipId.slice(0, 8)}`);
await fsp.mkdir(workDir, { recursive: true });
const result = await renderClip({
  sourceVideoPath: sourcePath,
  clip,
  template,
  transcriptSegments: transcriptRow.segments as unknown as TranscriptSegment[],
  faceTracker: new ReactionCamFaceTracker(),
  workDir,
  outputPath: outPath,
});
console.log(`OK ${outPath} (${result.durationSeconds.toFixed(1)}s, template ${clipRow.template})`);

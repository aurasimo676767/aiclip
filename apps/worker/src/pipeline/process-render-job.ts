import fsp from "node:fs/promises";
import path from "node:path";
import type { RenderJobRow, ClipRow, VideoRow, TranscriptRow } from "@clipforge/db";
import { DEFAULT_TEMPLATES, type TemplateName, type RankedClip, type TranscriptSegment } from "@clipforge/shared";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { storageProvider, faceTracker } from "../lib/providers.js";
import { renderClip } from "../render/render-clip.js";
import { renderLongformClip } from "../render/render-longform-clip.js";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { updateRenderJobStatus } from "../queue/render-queue.js";
import { withNetworkRetry } from "../lib/retry.js";
import { isRenderJobCancelled } from "../lib/cancellation.js";

export async function processRenderJob(job: RenderJobRow): Promise<void> {
  const jobDir = path.join(env.WORKER_TMP_DIR, `render-${job.id}`);
  await fsp.mkdir(jobDir, { recursive: true });

  // Diventa true SOLO dopo che la clip è stata marcata COMPLETED con successo: se un errore
  // arriva DOPO (es. il bookkeeping del render_job fallisce per un blip di rete), la clip è
  // comunque già pronta e renderizzata — non va ributtata su FAILED, altrimenti si perde una
  // clip riuscita per un problema puramente di scrittura successiva (bug reale osservato:
  // "Aggiornamento status render_job fallito: TypeError: fetch failed" dopo un render andato
  // a buon fine).
  let clipMarkedCompleted = false;

  // true se l'utente ha annullato: render_jobs/clips sono già stati marcati FAILED dal
  // pulsante "Annulla" lato web, il worker deve solo smettere di lavorarci senza
  // sovrascriverli (né tentare di marcarli COMPLETED se il render nel frattempo è finito).
  async function cancelled(): Promise<boolean> {
    const requested = await isRenderJobCancelled(job.id);
    if (requested) {
      logger.info("Render annullato dall'utente, interrompo", { jobId: job.id });
    }
    return requested;
  }

  try {
    await updateRenderJobStatus(job.id, "RENDERING", { stage: "loading" });
    await setClipStatus(job.clip_id, "RENDERING");

    const clipRow = await fetchClip(job.clip_id);
    const videoRow = await fetchVideo(clipRow.video_id);

    if (!videoRow.storage_path) {
      throw new Error("Il video sorgente non ha uno storage_path valido");
    }

    if (await cancelled()) return;

    const localSourcePath = path.join(jobDir, `source${path.extname(videoRow.storage_path)}`);
    await storageProvider.downloadToFile(videoRow.storage_path, localSourcePath);
    if (await cancelled()) return;

    await updateRenderJobStatus(job.id, "RENDERING", { stage: "rendering", progress: 20 });

    const outputPath = path.join(jobDir, "output.mp4");

    if (clipRow.format === "longform") {
      // Niente crop/zoom/captions per il long-form: solo trim + card dei crediti allo streamer
      // originale (vedi render-longform-clip.ts) — non serve né il transcript né il face tracker.
      await renderLongformClip({
        sourceVideoPath: localSourcePath,
        start: clipRow.start_time,
        end: clipRow.end_time,
        streamerName: videoRow.streamer_name,
        workDir: jobDir,
        outputPath,
      });
    } else {
      const transcriptRow = await fetchTranscript(clipRow.video_id);
      const template = DEFAULT_TEMPLATES[(clipRow.template as TemplateName) in DEFAULT_TEMPLATES ? (clipRow.template as TemplateName) : "PODCAST_CLEAN"];
      const rankedClip: RankedClip = {
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

      await renderClip({
        sourceVideoPath: localSourcePath,
        clip: rankedClip,
        template,
        transcriptSegments: transcriptRow.segments as TranscriptSegment[],
        faceTracker,
        workDir: jobDir,
        outputPath,
      });
    }

    if (await cancelled()) return;

    await updateRenderJobStatus(job.id, "RENDERING", { stage: "uploading", progress: 80 });

    const thumbnailPath = path.join(jobDir, "thumbnail.jpg");
    await runFfmpeg(["-y", "-i", outputPath, "-ss", "1", "-frames:v", "1", thumbnailPath]);

    const clipStoragePath = `clips/${clipRow.project_id}/${clipRow.id}.mp4`;
    const thumbStoragePath = `thumbnails/${clipRow.project_id}/${clipRow.id}.jpg`;
    await storageProvider.uploadFile(outputPath, clipStoragePath, "video/mp4");
    await storageProvider.uploadFile(thumbnailPath, thumbStoragePath, "image/jpeg");

    if (await cancelled()) return;

    const { error: updateError } = await withNetworkRetry(
      () =>
        supabase
          .from("clips")
          .update({
            status: "COMPLETED",
            output_video_path: clipStoragePath,
            thumbnail_path: thumbStoragePath,
            error_message: null,
          })
          .eq("id", clipRow.id),
      "Aggiornamento clip a COMPLETED",
    );
    if (updateError) {
      throw new Error(`Aggiornamento clip fallito: ${updateError.message}`);
    }
    clipMarkedCompleted = true;

    await updateRenderJobStatus(job.id, "COMPLETED", { stage: "done", progress: 100, completed_at: new Date().toISOString() });
    logger.info("Render clip completato", { clipId: clipRow.id, jobId: job.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Render clip fallito", { jobId: job.id, error: message, clipMarkedCompleted });

    await updateRenderJobStatus(job.id, "FAILED", { error_message: message, completed_at: new Date().toISOString() }).catch((e) => {
      logger.warn("Anche l'aggiornamento a FAILED del render_job è fallito, proseguo comunque", {
        jobId: job.id,
        error: e instanceof Error ? e.message : String(e),
      });
    });

    if (clipMarkedCompleted) {
      logger.warn("Clip già completata con successo: non la rimetto su FAILED nonostante l'errore successivo", {
        clipId: job.clip_id,
        error: message,
      });
    } else {
      await setClipStatus(job.clip_id, "FAILED", message);
    }
  } finally {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function setClipStatus(clipId: string, status: "RENDERING" | "FAILED", errorMessage?: string): Promise<void> {
  const { error } = await supabase
    .from("clips")
    .update({ status, error_message: errorMessage ?? null })
    .eq("id", clipId);
  if (error) {
    logger.warn("Aggiornamento status clip fallito", { clipId, error: error.message });
  }
}

async function fetchClip(clipId: string): Promise<ClipRow> {
  const { data, error } = await supabase.from("clips").select("*").eq("id", clipId).single();
  if (error || !data) {
    throw new Error(`Clip ${clipId} non trovata: ${error?.message ?? "nessun dato"}`);
  }
  return data;
}

async function fetchVideo(videoId: string): Promise<VideoRow> {
  const { data, error } = await supabase.from("videos").select("*").eq("id", videoId).single();
  if (error || !data) {
    throw new Error(`Video ${videoId} non trovato: ${error?.message ?? "nessun dato"}`);
  }
  return data;
}

async function fetchTranscript(videoId: string): Promise<TranscriptRow> {
  const { data, error } = await supabase.from("transcripts").select("*").eq("video_id", videoId).single();
  if (error || !data) {
    throw new Error(`Transcript per video ${videoId} non trovato: ${error?.message ?? "nessun dato"}`);
  }
  return data;
}

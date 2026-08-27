import fsp from "node:fs/promises";
import path from "node:path";
import type { VoiceoverJobRow } from "@clipforge/db";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { storageProvider, transcriptionProvider } from "../lib/providers.js";
import { renderVoiceoverClip } from "../render/render-voiceover-clip.js";
import { updateVoiceoverJobStatus } from "../queue/voiceover-queue.js";

/** Esegue il flusso "voice over": nessuna AI di selezione, la clip e l'audio sono già scelti dall'utente. */
export async function processVoiceoverJob(job: VoiceoverJobRow): Promise<void> {
  const jobDir = path.join(env.WORKER_TMP_DIR, `voiceover-${job.id}`);
  await fsp.mkdir(jobDir, { recursive: true });

  try {
    if (!job.video_storage_path || !job.audio_storage_path) {
      throw new Error("Il job non ha né il video né l'audio caricati su storage");
    }

    const videoPath = path.join(jobDir, `source_video${path.extname(job.video_storage_path)}`);
    const audioPath = path.join(jobDir, `source_audio${path.extname(job.audio_storage_path)}`);
    await storageProvider.downloadToFile(job.video_storage_path, videoPath);
    await storageProvider.downloadToFile(job.audio_storage_path, audioPath);

    logger.info("Trascrizione voice over avviata", { jobId: job.id });
    const transcript = await transcriptionProvider.transcribe(audioPath);

    const outputPath = path.join(jobDir, "output.mp4");
    await renderVoiceoverClip({
      videoPath,
      audioPath,
      transcriptSegments: transcript.segments,
      workDir: jobDir,
      outputPath,
    });

    const outputStoragePath = `voiceover/${job.user_id}/${job.id}.mp4`;
    await storageProvider.uploadFile(outputPath, outputStoragePath, "video/mp4");

    await updateVoiceoverJobStatus(job.id, "COMPLETED", { output_video_path: outputStoragePath, error_message: null });
    logger.info("Voice over completato", { jobId: job.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Pipeline voice over fallita", { jobId: job.id, error: message });
    await updateVoiceoverJobStatus(job.id, "FAILED", { error_message: message });
  } finally {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

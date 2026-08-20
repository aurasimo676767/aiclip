import fsp from "node:fs/promises";
import path from "node:path";
import type { VideoRow } from "@clipforge/db";
import { overallScore, DEFAULT_TEMPLATES, MAX_SUGGESTED_CLIPS } from "@clipforge/shared";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { storageProvider, transcriptionProvider } from "../lib/providers.js";
import { extractAudio } from "./extract-audio.js";
import { detectClipCandidates } from "../providers/ai/candidates.js";
import { rankAndBuildEdl } from "../providers/ai/ranking.js";
import { updateVideoStatus } from "../queue/video-queue.js";

/** Esegue l'intera pipeline di analisi per un video appena claimato: audio -> transcript -> AI -> clip suggerite. */
export async function processVideoJob(video: VideoRow): Promise<void> {
  const jobDir = path.join(env.WORKER_TMP_DIR, `video-${video.id}`);
  await fsp.mkdir(jobDir, { recursive: true });

  try {
    if (!video.storage_path) {
      throw new Error("Il video non ha un storage_path: upload non completato correttamente");
    }

    await updateVideoStatus(video.id, "EXTRACTING_AUDIO");
    const localVideoPath = path.join(jobDir, `source${path.extname(video.storage_path)}`);
    await storageProvider.downloadToFile(video.storage_path, localVideoPath);
    const audioPath = await extractAudio(localVideoPath, jobDir);

    await updateVideoStatus(video.id, "TRANSCRIBING");
    const transcript = await transcriptionProvider.transcribe(audioPath);

    const { error: transcriptError } = await supabase.from("transcripts").upsert(
      {
        video_id: video.id,
        language: transcript.language,
        duration_seconds: transcript.durationSeconds,
        full_text: transcript.fullText,
        segments: transcript.segments,
        provider: transcript.provider,
      },
      { onConflict: "video_id" },
    );
    if (transcriptError) {
      throw new Error(`Salvataggio transcript fallito: ${transcriptError.message}`);
    }

    await updateVideoStatus(video.id, "ANALYZING", { duration_seconds: transcript.durationSeconds });

    const candidates = await detectClipCandidates(transcript.segments, {
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL_CHEAP,
      videoTitle: video.original_filename,
      videoDurationSeconds: transcript.durationSeconds,
    });

    logger.info("Candidati individuati", { videoId: video.id, count: candidates.length });

    const rankedClips = await rankAndBuildEdl(candidates, transcript.segments, {
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL_STRONG,
      videoTitle: video.original_filename,
    });

    await updateVideoStatus(video.id, "CLIP_SELECTION");

    const clipsToInsert = rankedClips.slice(0, MAX_SUGGESTED_CLIPS).map((clip) => ({
      project_id: video.project_id,
      video_id: video.id,
      start_time: clip.start,
      end_time: clip.end,
      duration: clip.duration,
      title: clip.title,
      hook: clip.hook,
      reason: clip.reason,
      scores: clip.scores,
      editing_style: clip.editing_style,
      template: clip.edl.template,
      edl: clip.edl,
      status: "SUGGESTED" as const,
    }));

    if (clipsToInsert.length === 0) {
      throw new Error("L'AI non ha prodotto nessuna clip valida per questo video");
    }

    const { error: insertError } = await supabase.from("clips").insert(clipsToInsert);
    if (insertError) {
      throw new Error(`Inserimento clip fallito: ${insertError.message}`);
    }

    logger.info("Pipeline video completata", {
      videoId: video.id,
      clips: clipsToInsert.length,
      topScore: Math.max(...rankedClips.map((c) => overallScore(c.scores))),
      templates: [...new Set(clipsToInsert.map((c) => c.template))],
    });

    // Verifica di sanità: ogni template usato deve esistere nel registry condiviso.
    for (const c of clipsToInsert) {
      if (!(c.template in DEFAULT_TEMPLATES)) {
        logger.warn("Template sconosciuto restituito dall'AI, verrà usato PODCAST_CLEAN come fallback in fase di render", {
          template: c.template,
        });
      }
    }

    await updateVideoStatus(video.id, "READY");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Pipeline video fallita", { videoId: video.id, error: message });
    await updateVideoStatus(video.id, "FAILED", { error_message: message });
  } finally {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

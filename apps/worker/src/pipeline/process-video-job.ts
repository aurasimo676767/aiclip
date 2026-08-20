import fsp from "node:fs/promises";
import path from "node:path";
import type { VideoRow } from "@clipforge/db";
import { overallScore, DEFAULT_TEMPLATES, MAX_SUGGESTED_CLIPS } from "@clipforge/shared";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { storageProvider, transcriptionProvider } from "../lib/providers.js";
import { extractAudio } from "./extract-audio.js";
import { downloadYoutubeVideo } from "./download-youtube.js";
import { detectClipCandidates } from "../providers/ai/candidates.js";
import { rankAndBuildEdl } from "../providers/ai/ranking.js";
import { updateVideoStatus } from "../queue/video-queue.js";

/** Esegue l'intera pipeline di analisi per un video appena claimato: audio -> transcript -> AI -> clip suggerite. */
export async function processVideoJob(video: VideoRow): Promise<void> {
  const jobDir = path.join(env.WORKER_TMP_DIR, `video-${video.id}`);
  await fsp.mkdir(jobDir, { recursive: true });

  try {
    let localVideoPath: string;
    let videoTitle = video.original_filename;

    if (video.storage_path) {
      // Percorso "upload file": il client ha già caricato il video su Storage.
      await updateVideoStatus(video.id, "EXTRACTING_AUDIO");
      localVideoPath = path.join(jobDir, `source${path.extname(video.storage_path)}`);
      await storageProvider.downloadToFile(video.storage_path, localVideoPath);
    } else if (video.source_url) {
      // Percorso "URL YouTube": il worker scarica il video (yt-dlp) e lo carica su Storage
      // lui stesso, così il resto della pipeline (estrazione audio, render) resta identico
      // indipendentemente dalla sorgente.
      await updateVideoStatus(video.id, "DOWNLOADING");
      const downloaded = await downloadYoutubeVideo(video.source_url, jobDir);
      localVideoPath = downloaded.filePath;
      videoTitle = downloaded.title;

      const { data: project, error: projectFetchError } = await supabase
        .from("projects")
        .select("user_id")
        .eq("id", video.project_id)
        .single();
      if (projectFetchError || !project) {
        throw new Error(`Impossibile recuperare il progetto per l'import YouTube: ${projectFetchError?.message}`);
      }

      const storagePath = `videos/${project.user_id}/${video.id}/source.mp4`;
      await storageProvider.uploadFile(localVideoPath, storagePath, "video/mp4");
      const stat = await fsp.stat(localVideoPath);

      const { error: videoUpdateError } = await supabase
        .from("videos")
        .update({
          storage_path: storagePath,
          size_bytes: stat.size,
          mime_type: "video/mp4",
          original_filename: downloaded.title,
        })
        .eq("id", video.id);
      if (videoUpdateError) {
        throw new Error(`Aggiornamento video (import YouTube) fallito: ${videoUpdateError.message}`);
      }

      const { error: projectUpdateError } = await supabase
        .from("projects")
        .update({ title: downloaded.title })
        .eq("id", video.project_id);
      if (projectUpdateError) {
        logger.warn("Aggiornamento titolo progetto fallito", { error: projectUpdateError.message });
      }

      await updateVideoStatus(video.id, "EXTRACTING_AUDIO");
    } else {
      throw new Error("Il video non ha né uno storage_path né un source_url: impossibile procedere");
    }

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
      videoTitle,
      videoDurationSeconds: transcript.durationSeconds,
    });

    logger.info("Candidati individuati", { videoId: video.id, count: candidates.length });

    const rankedClips = await rankAndBuildEdl(candidates, transcript.segments, {
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL_STRONG,
      videoTitle,
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

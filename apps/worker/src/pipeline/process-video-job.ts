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
import { withNetworkRetry } from "../lib/retry.js";
import { isVideoCancelled } from "../lib/cancellation.js";

// Tentativi automatici prima di arrendersi e marcare FAILED (serve poi il pulsante "Riprova"
// manuale): stesso numero di default usato da claim_next_video per lo stale-reclaim, così i due
// meccanismi (retry automatico e stale-reclaim) si esauriscono in modo coerente.
const MAX_AUTO_RETRY_ATTEMPTS = 3;

/** Esegue l'intera pipeline di analisi per un video appena claimato: audio -> transcript -> AI -> clip suggerite. */
export async function processVideoJob(video: VideoRow): Promise<void> {
  const jobDir = path.join(env.WORKER_TMP_DIR, `video-${video.id}`);
  await fsp.mkdir(jobDir, { recursive: true });

  const { data: project, error: projectFetchError } = await supabase
    .from("projects")
    .select("id, user_id, auto_generate_clips")
    .eq("id", video.project_id)
    .single();
  if (projectFetchError || !project) {
    logger.error("Impossibile recuperare il progetto per il video", { videoId: video.id, error: projectFetchError?.message });
    await updateVideoStatus(video.id, "FAILED", { error_message: `Progetto non trovato: ${projectFetchError?.message}` });
    return;
  }

  // true se l'utente ha annullato: usato per uscire silenziosamente (status/error_message sono
  // già stati impostati dal pulsante "Annulla" lato web, il worker deve solo smettere di
  // lavorarci senza sovrascriverli né innescare il retry automatico del blocco catch).
  async function cancelled(): Promise<boolean> {
    const requested = await isVideoCancelled(video.id);
    if (requested) {
      logger.info("Video annullato dall'utente, interrompo la pipeline", { videoId: video.id });
    }
    return requested;
  }

  try {
    if (await cancelled()) return;

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
    if (await cancelled()) return;

    await updateVideoStatus(video.id, "TRANSCRIBING");
    const transcript = await transcriptionProvider.transcribe(audioPath);
    if (await cancelled()) return;

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
    if (await cancelled()) return;

    const rankedClips = await rankAndBuildEdl(candidates, transcript.segments, {
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL_STRONG,
      videoTitle,
      sourceVideoPath: localVideoPath,
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
      hashtags: clip.hashtags,
      caption: clip.caption,
      badges: clip.badges,
      status: "SUGGESTED" as const,
    }));

    if (clipsToInsert.length === 0) {
      throw new Error("L'AI non ha prodotto nessuna clip valida per questo video");
    }

    const { data: insertedClips, error: insertError } = await withNetworkRetry(
      () => supabase.from("clips").insert(clipsToInsert).select("id"),
      "Inserimento clip",
    );
    if (insertError) {
      throw new Error(`Inserimento clip fallito: ${insertError.message}`);
    }

    // "Genera più video": nessuna selezione manuale, si mette subito in render tutto ciò che
    // l'AI ha suggerito (vedi il flag impostato in /api/projects/youtube/bulk).
    if (project.auto_generate_clips && insertedClips && insertedClips.length > 0) {
      const newClipIds = insertedClips.map((c) => c.id);
      const { error: renderJobsError } = await withNetworkRetry(
        () => supabase.from("render_jobs").insert(newClipIds.map((clip_id) => ({ clip_id }))),
        "Inserimento render job (auto-generate)",
      );
      if (renderJobsError) {
        logger.warn("Auto-generate: creazione render job fallita", { videoId: video.id, error: renderJobsError.message });
      } else {
        const { error: statusError } = await withNetworkRetry(
          () => supabase.from("clips").update({ status: "QUEUED" }).in("id", newClipIds),
          "Aggiornamento status clip (auto-generate)",
        );
        if (statusError) {
          logger.warn("Auto-generate: aggiornamento status clip fallito", { videoId: video.id, error: statusError.message });
        }
      }
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
    logger.error("Pipeline video fallita", { videoId: video.id, error: message, attempts: video.attempts });

    // video.attempts è già stato incrementato dal claim (claim_next_video): se non abbiamo
    // ancora esaurito i tentativi automatici, rimettiamo il video in coda da solo (status
    // UPLOADED, claim azzerato) invece di marcare FAILED e aspettare un click manuale — un
    // blip transitorio (rete, API) si risolve così senza intervento. Solo dopo
    // MAX_AUTO_RETRY_ATTEMPTS tentativi resta FAILED (il pulsante "Riprova" azzera gli attempts
    // per altri 3 tentativi freschi).
    if (video.attempts < MAX_AUTO_RETRY_ATTEMPTS) {
      logger.warn("Rimetto in coda automaticamente per un nuovo tentativo", { videoId: video.id, attempts: video.attempts });
      await updateVideoStatus(video.id, "UPLOADED", { error_message: message, claimed_by: null, claimed_at: null });
    } else {
      await updateVideoStatus(video.id, "FAILED", { error_message: message });
    }
  } finally {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

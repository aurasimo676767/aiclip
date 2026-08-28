import fsp from "node:fs/promises";
import path from "node:path";
import type { VideoRow } from "@clipforge/db";
import {
  overallScore,
  DEFAULT_TEMPLATES,
  MAX_SUGGESTED_CLIPS,
  MAX_SUGGESTED_LONGFORM_CLIPS,
  type TranscriptSegment,
  type ClipScores,
  type EditingStyle,
  type TemplateName,
  type EditDecisionList,
  type ClipBadge,
} from "@clipforge/shared";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { storageProvider, transcriptionProvider } from "../lib/providers.js";
import { extractAudio } from "./extract-audio.js";
import { downloadYoutubeVideo } from "./download-youtube.js";
import { detectClipCandidates } from "../providers/ai/candidates.js";
import { rankAndBuildEdl } from "../providers/ai/ranking.js";
import { detectLongformCandidates } from "../providers/ai/longform-candidates.js";
import { rankLongformClips } from "../providers/ai/longform-ranking.js";
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

  // false SOLO quando l'errore sta per essere ritentato in automatico (vedi blocco catch): in
  // quel caso jobDir NON va ripulito, altrimenti un download lungo interrotto a metà (un VOD
  // Twitch di ore, scaricato a frammenti) ripartirebbe sempre da zero invece di riprendere dai
  // frammenti già scaricati (yt-dlp lo fa da solo se i file restano, vedi download-youtube.ts).
  let shouldCleanupJobDir = true;

  const { data: project, error: projectFetchError } = await supabase
    .from("projects")
    .select("id, user_id, auto_generate_clips, source_type")
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

    const isLongform = project.source_type === "twitch_vod";

    // Riusa un transcript già salvato per questo video (es. una rigenerazione manuale delle clip
    // dopo aver aggiustato un prompt, o un retry dopo che la trascrizione era già andata a buon
    // fine) invece di rifare estrazione audio + trascrizione da zero — su un VOD di ore è la
    // fase più lenta dopo il download, non ha senso ripeterla se il risultato è già valido.
    const { data: existingTranscriptRow } = await supabase.from("transcripts").select("*").eq("video_id", video.id).maybeSingle();

    // Controllo preventivo: se il provider di trascrizione lo implementa (es. il server Whisper
    // locale) e serve DAVVERO trascrivere (nessun transcript da riusare), verifica in pochi
    // secondi che sia raggiungibile PRIMA di impegnarsi in un download che su un VOD lungo può
    // durare ore — altrimenti lo scopriremmo solo alla fine. Se il transcript esiste già, il
    // server Whisper non serve proprio: non ha senso far fallire una rigenerazione solo perché
    // è spento, quando non verrà comunque usato.
    if (!existingTranscriptRow) {
      await transcriptionProvider.checkReady?.();
    }

    // Il file video locale serve per: estrarlo se manca il transcript (qualunque formato), o per
    // i frame campionati dal ranking Shorts (sempre, anche con transcript riusato). Il ranking
    // long-form invece non guarda mai il video, solo il transcript — se lo riusiamo, per il
    // long-form si può saltare anche il download (che per un VOD di ore, anche solo da R2 a
    // locale, non è gratis: minuti di rete + I/O su disco per niente).
    const needsLocalVideoFile = !existingTranscriptRow || !isLongform;

    let localVideoPath: string | null = null;
    let videoTitle = video.original_filename;

    if (needsLocalVideoFile) {
      if (video.storage_path) {
        // Percorso "upload file" (o video già scaricato in un tentativo precedente).
        await updateVideoStatus(video.id, "EXTRACTING_AUDIO");
        localVideoPath = path.join(jobDir, `source${path.extname(video.storage_path)}`);
        await storageProvider.downloadToFile(video.storage_path, localVideoPath);
      } else if (video.source_url) {
        // Percorso "URL esterno" (YouTube o VOD Twitch, yt-dlp supporta entrambi senza distinzioni
        // di codice): il worker scarica il video e lo carica su Storage lui stesso, così il resto
        // della pipeline (estrazione audio, render) resta identico indipendentemente dalla sorgente.
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
    }

    let transcript: { language: string; durationSeconds: number; fullText: string; segments: TranscriptSegment[]; provider: string };
    if (existingTranscriptRow) {
      logger.info("Transcript già presente, salto estrazione audio e trascrizione", { videoId: video.id, skippedDownload: !needsLocalVideoFile });
      transcript = {
        language: existingTranscriptRow.language,
        durationSeconds: existingTranscriptRow.duration_seconds,
        fullText: existingTranscriptRow.full_text,
        segments: existingTranscriptRow.segments as TranscriptSegment[],
        provider: existingTranscriptRow.provider,
      };
    } else {
      if (!localVideoPath) {
        throw new Error("localVideoPath mancante: percorso inatteso, il file andava scaricato prima di estrarne l'audio");
      }
      const audioPath = await extractAudio(localVideoPath, jobDir);
      if (await cancelled()) return;

      await updateVideoStatus(video.id, "TRANSCRIBING");
      transcript = await transcriptionProvider.transcribe(audioPath);
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
    }

    await updateVideoStatus(video.id, "ANALYZING", { duration_seconds: transcript.durationSeconds });

    let clipsToInsert: ClipToInsert[];
    if (isLongform) {
      clipsToInsert = await buildLongformClipsToInsert(video, transcript.segments, transcript.durationSeconds, videoTitle);
    } else {
      // Per lo Short il file locale serve sempre (frame per il ranking) — needsLocalVideoFile è
      // sempre true quando !isLongform, quindi localVideoPath è garantito qui, ma lo verifichiamo
      // comunque invece di un cast silenzioso.
      if (!localVideoPath) {
        throw new Error("localVideoPath mancante per la pipeline Shorts: percorso inatteso");
      }
      clipsToInsert = await buildShortClipsToInsert(
        video,
        transcript.segments,
        transcript.durationSeconds,
        videoTitle,
        project.user_id,
        localVideoPath,
      );
    }

    if (await cancelled()) return;
    await updateVideoStatus(video.id, "CLIP_SELECTION");

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
      format: isLongform ? "longform" : "short",
      clips: clipsToInsert.length,
      topScore: Math.max(...clipsToInsert.map((c) => overallScore(c.scores))),
      templates: [...new Set(clipsToInsert.map((c) => c.template))],
    });

    // Verifica di sanità: ogni template usato deve esistere nel registry condiviso (i longform
    // usano sempre PODCAST_CLEAN come placeholder — il render long-form ignora comunque questo
    // campo, non serve mai risolverlo davvero).
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
      shouldCleanupJobDir = false;
    } else {
      await updateVideoStatus(video.id, "FAILED", { error_message: message });
    }
  } finally {
    if (shouldCleanupJobDir) {
      await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

type ClipToInsert = ReturnType<typeof buildInsertRow>;

function buildInsertRow(params: {
  video: VideoRow;
  start: number;
  end: number;
  duration: number;
  title: string;
  hook: string;
  reason: string;
  scores: ClipScores;
  editingStyle: EditingStyle;
  template: TemplateName;
  edl: EditDecisionList;
  hashtags: string[];
  caption: string;
  badges: ClipBadge[];
  format: "short" | "longform";
}) {
  return {
    project_id: params.video.project_id,
    video_id: params.video.id,
    start_time: params.start,
    end_time: params.end,
    duration: params.duration,
    title: params.title,
    hook: params.hook,
    reason: params.reason,
    scores: params.scores,
    editing_style: params.editingStyle,
    template: params.template,
    edl: params.edl,
    hashtags: params.hashtags,
    caption: params.caption,
    badges: params.badges,
    format: params.format,
    status: "SUGGESTED" as const,
  };
}

/** Pipeline Shorts esistente: finestre hook-payoff + crop/zoom/captions via EDL. */
async function buildShortClipsToInsert(
  video: VideoRow,
  segments: TranscriptSegment[],
  videoDurationSeconds: number,
  videoTitle: string,
  userId: string,
  localVideoPath: string,
): Promise<ClipToInsert[]> {
  const candidates = await detectClipCandidates(segments, {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL_CHEAP,
    videoTitle,
    videoDurationSeconds,
  });
  logger.info("Candidati Shorts individuati", { videoId: video.id, count: candidates.length });

  const rankedClips = await rankAndBuildEdl(candidates, segments, {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL_STRONG,
    videoTitle,
    sourceVideoPath: localVideoPath,
    userId,
  });

  return rankedClips.slice(0, MAX_SUGGESTED_CLIPS).map((clip) =>
    buildInsertRow({
      video,
      start: clip.start,
      end: clip.end,
      duration: clip.duration,
      title: clip.title,
      hook: clip.hook,
      reason: clip.reason,
      scores: clip.scores,
      editingStyle: clip.editing_style,
      template: clip.edl.template,
      edl: clip.edl,
      hashtags: clip.hashtags,
      caption: clip.caption,
      badges: clip.badges,
      format: "short",
    }),
  );
}

/** Pipeline long-form (VOD Twitch): segmenti per argomento, niente crop/zoom/captions. */
async function buildLongformClipsToInsert(
  video: VideoRow,
  segments: TranscriptSegment[],
  videoDurationSeconds: number,
  videoTitle: string,
): Promise<ClipToInsert[]> {
  const candidates = await detectLongformCandidates(segments, {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL_CHEAP,
    videoTitle,
    videoDurationSeconds,
  });
  logger.info("Candidati long-form individuati", { videoId: video.id, count: candidates.length });

  const rankedClips = await rankLongformClips(candidates, segments, {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL_STRONG,
    videoTitle,
    streamerName: video.streamer_name,
  });

  // editing_style/template/edl sono placeholder inerti: il render long-form (vedi
  // render-longform-clip.ts) non li legge mai, esistono solo perché le colonne DB sono NOT NULL
  // e condivise con gli Shorts.
  return rankedClips.slice(0, MAX_SUGGESTED_LONGFORM_CLIPS).map((clip) =>
    buildInsertRow({
      video,
      start: clip.start,
      end: clip.end,
      duration: clip.duration,
      title: clip.title,
      hook: clip.hook,
      reason: clip.reason,
      scores: clip.scores,
      editingStyle: "clean",
      template: "PODCAST_CLEAN",
      edl: { template: "PODCAST_CLEAN", events: [] },
      hashtags: clip.hashtags,
      caption: clip.caption,
      badges: clip.badges,
      format: "longform",
    }),
  );
}

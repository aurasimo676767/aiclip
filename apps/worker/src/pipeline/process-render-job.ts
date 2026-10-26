import fsp from "node:fs/promises";
import path from "node:path";
import type { RenderJobRow, ClipRow, VideoRow, TranscriptRow } from "@clipforge/db";
import { DEFAULT_TEMPLATES, normalizeCaptionSettings, type CaptionSettings, type TemplateName, type RankedClip, type TranscriptSegment } from "@clipforge/shared";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { storageProvider, faceTracker } from "../lib/providers.js";
import { getOrDownloadSourceFile } from "../lib/source-download-cache.js";
import { redownloadSourceVideo } from "../lib/redownload-source.js";
import { isRenderPlan, renderClip } from "../render/render-clip.js";
import { planContentViews } from "../providers/ai/content-focus.js";
import { renderLongformClip } from "../render/render-longform-clip.js";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { updateRenderJobStatus } from "../queue/render-queue.js";
import { withNetworkRetry } from "../lib/retry.js";
import { isRenderJobCancelled } from "../lib/cancellation.js";
import { ensureLongformGames, gamesToKeep } from "./longform-games.js";
import { peopleHintForVideo } from "../face-tracking/face-identity.js";
import type { PeopleHint } from "../face-tracking/face-tracker.js";

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

    if (await cancelled()) return;

    let localSourcePath: string;
    if (videoRow.storage_path) {
      // Cache condivisa per storage_path: se un altro render della stessa clip/video è già in
      // corso a scaricarlo (RENDER_CONCURRENCY > 1), questa chiamata aspetta lo stesso download
      // invece di duplicarlo — su un VOD long-form da 20+ GB, due download contemporanei hanno
      // già mandato in crash il worker per esaurimento RAM (osservato in pratica).
      localSourcePath = await getOrDownloadSourceFile(storageProvider, videoRow.storage_path);
    } else {
      // Sorgente ripulita da R2 (vedi cleanup-source.ts, scatta quando tutte le clip di un
      // video erano terminali) ma serve di nuovo per questo render — la ripristiniamo dalla
      // piattaforma originale invece di fallire.
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("user_id")
        .eq("id", clipRow.project_id)
        .single();
      if (projectError || !project) {
        throw new Error(`Progetto non trovato per il video ${videoRow.id}: impossibile riscaricare la sorgente ripulita`);
      }
      localSourcePath = await redownloadSourceVideo(videoRow, project.user_id);
    }
    if (await cancelled()) return;

    await updateRenderJobStatus(job.id, "RENDERING", { stage: "rendering", progress: 20 });

    const outputPath = path.join(jobDir, "output.mp4");
    // Solo per gli Shorts: la regia da riusare quando cambia solo lo stile dei sottotitoli.
    let renderPlan: unknown = null;

    if (clipRow.format === "longform") {
      // Long-form: solo taglio, oppure montaggio "da YouTuber" se acceso sulla clip (vedi
      // render-longform-clip.ts e longform-highlights.ts): lì serve la trascrizione. Niente sottotitoli.
      // Colonna aggiunta dalla migrazione 0024: prima della migrazione non c'è e vale "spento".
      const edited = (clipRow as { longform_edit?: boolean }).longform_edit === true;
      const segments = edited ? ((await fetchTranscript(clipRow.video_id)).segments as TranscriptSegment[]) : [];
      // Giochi riconosciuti dallo schermo (colonne della migrazione 0029): se mancano si riconoscono ora.
      const gameRow = clipRow as { longform_games?: unknown; longform_keep_games?: unknown };
      const timeline = edited
        ? await ensureLongformGames({ id: clipRow.id, start_time: clipRow.start_time, end_time: clipRow.end_time, longform_games: gameRow.longform_games }, localSourcePath)
        : null;
      const games = timeline ? { timeline, keep: gamesToKeep(timeline, gameRow.longform_keep_games) } : undefined;
      if (games) logger.info("Montaggio: giochi tenuti", { clipId: clipRow.id, keep: games.keep });
      await renderLongformClip({
        sourceVideoPath: localSourcePath,
        start: clipRow.start_time,
        end: clipRow.end_time,
        workDir: jobDir,
        outputPath,
        autoEdit: edited
          ? {
              highlights: {
                title: clipRow.title,
                segments,
                apiKey: env.ANTHROPIC_API_KEY,
                model: env.ANTHROPIC_MODEL_LONGFORM_EDIT,
                phaseModel: env.ANTHROPIC_MODEL_MATCH_PHASES === "off" ? undefined : env.ANTHROPIC_MODEL_MATCH_PHASES,
                openaiApiKey: env.OPENAI_API_KEY,
                games,
              },
            }
          : undefined,
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

      // "captions" = cambia solo lo stile: si riusa la regia del render precedente, niente AI.
      const reusePlan = job.mode === "captions" && isRenderPlan(clipRow.render_plan) ? clipRow.render_plan : null;
      if (job.mode === "captions" && !reusePlan) logger.info("Cambio stile su uno Short senza regia salvata: render completo", { clipId: clipRow.id });
      const captionSettings = await captionSettingsFor(clipRow, template.showProgressBar);
      const rendered = await renderClip({
        sourceVideoPath: localSourcePath,
        clip: rankedClip,
        template,
        transcriptSegments: transcriptRow.segments as TranscriptSegment[],
        faceTracker,
        workDir: jobDir,
        outputPath,
        captionSettings,
        plan: reusePlan,
        previewOutputPath: path.join(jobDir, "preview.mp4"),
        trackOutputPath: path.join(jobDir, "captions.json"),
        people: reusePlan ? undefined : await peopleHintForRender(videoRow, clipRow.project_id, jobDir),
        planContentViews:
          env.ANTHROPIC_MODEL_CONTENT_FOCUS === "off"
            ? undefined
            : (input) => planContentViews(input, { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL_CONTENT_FOCUS }),
      });
      renderPlan = rendered.plan;
    }

    if (await cancelled()) return;

    await updateRenderJobStatus(job.id, "RENDERING", { stage: "uploading", progress: 80 });

    const thumbnailPath = path.join(jobDir, "thumbnail.jpg");
    await runFfmpeg(["-y", "-i", outputPath, "-ss", "1", "-frames:v", "1", thumbnailPath]);

    const clipStoragePath = `clips/${clipRow.project_id}/${clipRow.id}.mp4`;
    const thumbStoragePath = `thumbnails/${clipRow.project_id}/${clipRow.id}.jpg`;
    await storageProvider.uploadFile(outputPath, clipStoragePath, "video/mp4");
    await storageProvider.uploadFile(thumbnailPath, thumbStoragePath, "image/jpeg");
    // Anteprima senza sottotitoli e parole coi tempi: il sito ci disegna sopra gli stili dal vivo.
    const previewPath = path.join(jobDir, "preview.mp4");
    const trackPath = path.join(jobDir, "captions.json");
    const hasPreview = clipRow.format !== "longform" && (await fileExists(previewPath)) && (await fileExists(trackPath));
    const previewStoragePath = `clips/${clipRow.project_id}/${clipRow.id}.preview.mp4`;
    const trackStoragePath = `clips/${clipRow.project_id}/${clipRow.id}.captions.json`;
    if (hasPreview) {
      await storageProvider.uploadFile(previewPath, previewStoragePath, "video/mp4");
      await storageProvider.uploadFile(trackPath, trackStoragePath, "application/json");
    }

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
            ...(hasPreview ? { preview_video_path: previewStoragePath, caption_track_path: trackStoragePath } : {}),
            ...(renderPlan ? { render_plan: renderPlan } : {}),
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
    // Il sorgente NON viene più ripulito automaticamente da qui: vedi cleanup-source.ts — è
    // l'utente a decidere quando liberare lo spazio, dal tasto "Elimina sorgente" in dashboard.
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

async function fileExists(file: string): Promise<boolean> {
  return fsp.access(file).then(
    () => true,
    () => false,
  );
}

/**
 * Stile dei sottotitoli per questo Short: quello scelto per lo Short, altrimenti lo stile di partenza
 * dell'account, altrimenti il Classico. Senza nessuna scelta la barra di avanzamento resta quella del
 * template, come prima che gli stili esistessero.
 */
async function captionSettingsFor(clip: ClipRow, templateProgressBar: boolean): Promise<CaptionSettings> {
  if (clip.caption_settings) return normalizeCaptionSettings(clip.caption_settings);
  const { data } = await supabase.from("projects").select("profiles(default_caption_settings)").eq("id", clip.project_id).maybeSingle();
  const profileDefault = (data as { profiles?: { default_caption_settings?: unknown } | null } | null)?.profiles?.default_caption_settings;
  if (profileDefault) return normalizeCaptionSettings(profileDefault);
  return { ...normalizeCaptionSettings(null), progressBar: templateProgressBar };
}

async function fetchClip(clipId: string): Promise<ClipRow> {
  const { data, error } = await supabase.from("clips").select("*").eq("id", clipId).single();
  if (error || !data) {
    throw new Error(`Clip ${clipId} non trovata: ${error?.message ?? "nessun dato"}`);
  }
  return data;
}

/** Persone della pagina Facce del proprietario del progetto e chi è il proprietario del canale del video. */
async function peopleHintForRender(video: VideoRow, projectId: string, workDir: string): Promise<PeopleHint | undefined> {
  const { data: project } = await supabase.from("projects").select("user_id").eq("id", projectId).maybeSingle();
  return project ? peopleHintForVideo(video, project.user_id, workDir) : undefined;
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

import fsp from "node:fs/promises";
import path from "node:path";
import type { YoutubePublishJobRow } from "@clipforge/db";
import { env } from "../env.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";
import { uploadVideoToYoutube } from "../providers/youtube/youtube-publisher.js";
import { updatePublishJobStatus } from "../queue/publish-queue.js";

export async function processPublishJob(job: YoutubePublishJobRow): Promise<void> {
  const jobDir = path.join(env.WORKER_TMP_DIR, `publish-${job.id}`);
  await fsp.mkdir(jobDir, { recursive: true });

  try {
    await updatePublishJobStatus(job.id, "UPLOADING");

    const { data: clip, error: clipError } = await supabase
      .from("clips")
      .select("id, project_id, status, output_video_path, format")
      .eq("id", job.clip_id)
      .single();
    if (clipError || !clip) {
      throw new Error(`Clip ${job.clip_id} non trovata: ${clipError?.message ?? "nessun dato"}`);
    }
    if (clip.status !== "COMPLETED" || !clip.output_video_path) {
      throw new Error("La clip non è ancora stata renderizzata");
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("user_id")
      .eq("id", clip.project_id)
      .single();
    if (projectError || !project) {
      throw new Error(`Progetto per la clip ${clip.id} non trovato: ${projectError?.message}`);
    }

    const { data: connection, error: connectionError } = await supabase
      .from("youtube_connections")
      .select("*")
      .eq("user_id", project.user_id)
      .single();
    if (connectionError || !connection) {
      throw new Error("Nessun account YouTube collegato per questo utente");
    }

    const localVideoPath = path.join(jobDir, "clip.mp4");
    await storageProvider.downloadToFile(clip.output_video_path, localVideoPath);

    const result = await uploadVideoToYoutube({
      credentials: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        accessToken: connection.access_token,
        refreshToken: connection.refresh_token,
        expiryDate: new Date(connection.expires_at).getTime(),
      },
      filePath: localVideoPath,
      title: job.title,
      description: job.description,
      tags: (job.tags as string[] | null) ?? [],
      privacyStatus: job.privacy_status,
      publishAt: job.publish_at,
      videoKind: clip.format === "longform" ? "longform" : "short",
    });

    if (result.refreshedAccessToken) {
      const { error: refreshUpdateError } = await supabase
        .from("youtube_connections")
        .update({
          access_token: result.refreshedAccessToken,
          expires_at: result.refreshedExpiresAt ?? connection.expires_at,
        })
        .eq("id", connection.id);
      if (refreshUpdateError) {
        logger.warn("Aggiornamento token YouTube rinnovato fallito", { error: refreshUpdateError.message });
      }
    }

    await updatePublishJobStatus(job.id, "COMPLETED", {
      youtube_video_id: result.videoId,
      youtube_url: result.url,
      completed_at: new Date().toISOString(),
    });
    logger.info("Pubblicazione YouTube completata", { jobId: job.id, clipId: clip.id, url: result.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Pubblicazione YouTube fallita", { jobId: job.id, error: message });
    await updatePublishJobStatus(job.id, "FAILED", { error_message: message, completed_at: new Date().toISOString() });
  } finally {
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

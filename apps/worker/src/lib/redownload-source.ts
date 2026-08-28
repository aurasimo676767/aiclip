import fsp from "node:fs/promises";
import type { VideoRow } from "@clipforge/db";
import { supabase } from "./supabase.js";
import { storageProvider } from "./providers.js";
import { downloadYoutubeVideo } from "../pipeline/download-youtube.js";
import { logger } from "./logger.js";

/**
 * Ripristina video.storage_path riscaricando dalla piattaforma originale (yt-dlp, supporta sia
 * YouTube sia Twitch) e ricaricando su R2 — serve quando il sorgente è stato ripulito da
 * cleanup-source.ts (per risparmiare spazio) ma un render/retry successivo ne ha di nuovo
 * bisogno. Ritorna il path locale già scaricato, così il chiamante non deve ri-scaricarlo da R2
 * subito dopo averlo appena caricato.
 */
export async function redownloadSourceVideo(video: VideoRow, projectUserId: string, jobDir: string): Promise<string> {
  if (!video.source_url) {
    throw new Error(
      `Il video "${video.id}" non ha un source_url da cui riscaricare (era un upload diretto, la sorgente ripulita non è recuperabile)`,
    );
  }

  logger.info("Sorgente non più su storage, riscarico dalla piattaforma originale", { videoId: video.id, sourceUrl: video.source_url });

  await fsp.mkdir(jobDir, { recursive: true });
  const downloaded = await downloadYoutubeVideo(video.source_url, jobDir);
  const storagePath = `videos/${projectUserId}/${video.id}/source.mp4`;
  await storageProvider.uploadFile(downloaded.filePath, storagePath, "video/mp4");
  const stat = await fsp.stat(downloaded.filePath);

  const { error } = await supabase
    .from("videos")
    .update({ storage_path: storagePath, size_bytes: stat.size, mime_type: "video/mp4" })
    .eq("id", video.id);
  if (error) {
    throw new Error(`Aggiornamento video (ri-download sorgente) fallito: ${error.message}`);
  }

  return downloaded.filePath;
}

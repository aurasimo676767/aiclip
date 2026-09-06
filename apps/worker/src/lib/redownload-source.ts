import fsp from "node:fs/promises";
import type { VideoRow } from "@clipforge/db";
import { supabase } from "./supabase.js";
import { storageProvider } from "./providers.js";
import { downloadYoutubeVideo } from "../pipeline/download-youtube.js";
import { ensureEnoughDiskSpaceForDownload } from "./disk-space.js";
import { getOrRedownloadFromPlatform, invalidateRedownloadCache } from "./source-download-cache.js";
import { env } from "../env.js";
import { logger } from "./logger.js";

/**
 * Ripristina video.storage_path riscaricando dalla piattaforma originale (yt-dlp, supporta sia
 * YouTube sia Twitch) e ricaricando su R2 — serve quando il sorgente è stato ripulito da
 * cleanup-source.ts (per risparmiare spazio) ma un render/retry successivo ne ha di nuovo
 * bisogno. Ritorna il path locale già scaricato, così il chiamante non deve ri-scaricarlo da R2
 * subito dopo averlo appena caricato.
 *
 * Il download passa da getOrRedownloadFromPlatform (cartella STABILE per video.id, non per
 * render_job.id): se il worker viene interrotto a metà (kill, riavvio del PC) e il video torna in
 * coda, il prossimo tentativo riprende dagli stessi frammenti già scaricati invece di ripartire da
 * zero — prima ogni render_job scriveva nella propria cartella temporanea e perdeva tutto il
 * progresso a ogni riavvio (osservato in pratica: 19GB persi su un VOD di 5h+).
 */
export async function redownloadSourceVideo(video: VideoRow, projectUserId: string): Promise<string> {
  if (!video.source_url) {
    throw new Error(
      `Il video "${video.id}" non ha un source_url da cui riscaricare (era un upload diretto, la sorgente ripulita non è recuperabile)`,
    );
  }

  logger.info("Sorgente non più su storage, riscarico dalla piattaforma originale", { videoId: video.id, sourceUrl: video.source_url });

  if (video.duration_seconds) {
    await ensureEnoughDiskSpaceForDownload(env.WORKER_TMP_DIR, video.duration_seconds);
  }

  const sourceUrl = video.source_url;
  const filePath = await getOrRedownloadFromPlatform(video.id, (targetDir) => downloadYoutubeVideo(sourceUrl, targetDir).then((d) => d.filePath));

  const storagePath = `videos/${projectUserId}/${video.id}/source.mp4`;
  await storageProvider.uploadFile(filePath, storagePath, "video/mp4");
  const stat = await fsp.stat(filePath);

  const { error } = await supabase
    .from("videos")
    .update({ storage_path: storagePath, size_bytes: stat.size, mime_type: "video/mp4" })
    .eq("id", video.id);
  if (error) {
    throw new Error(`Aggiornamento video (ri-download sorgente) fallito: ${error.message}`);
  }

  // Non serve più: da qui in poi video.storage_path è di nuovo valorizzato, i render successivi
  // passano dalla cache R2 normale (getOrDownloadSourceFile), non da questa.
  await invalidateRedownloadCache(video.id);

  return filePath;
}

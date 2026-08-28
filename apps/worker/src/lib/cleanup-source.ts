import { supabase } from "./supabase.js";
import { storageProvider } from "./providers.js";
import { logger } from "./logger.js";
import { invalidateSourceCache } from "./source-download-cache.js";

/**
 * Dopo che una render_job termina (successo o fallimento), se TUTTE le clip di quel video sono
 * ormai in stato terminale (COMPLETED/FAILED, nessuna QUEUED/RENDERING rimasta) il sorgente
 * originale — su un VOD long-form anche 20+ GB — non serve più: viene eliminato sia da R2 sia
 * dalla cache locale condivisa, per tenere sotto controllo lo spazio (sia sul bucket R2 sia sul
 * disco locale). Se in futuro serve di nuovo (retry su una clip, o una clip nuova aggiunta a
 * mano) viene ri-scaricato al bisogno dalla piattaforma originale (vedi redownload-source.ts) —
 * non è una perdita definitiva, solo un dato non tenuto "caldo" quando non serve.
 */
export async function maybeCleanupSourceAfterClips(videoId: string): Promise<void> {
  const { data: clips, error: clipsError } = await supabase.from("clips").select("status").eq("video_id", videoId);
  if (clipsError || !clips || clips.length === 0) return;

  const stillPending = clips.some((c) => c.status === "QUEUED" || c.status === "RENDERING");
  if (stillPending) return;

  const { data: video, error: videoError } = await supabase.from("videos").select("id, storage_path").eq("id", videoId).single();
  if (videoError || !video || !video.storage_path) return; // già ripulito, o mai stato scaricato

  const storagePath = video.storage_path;

  try {
    await storageProvider.remove(storagePath);
  } catch (err) {
    // Non azzeriamo storage_path se la remove è fallita: altrimenti perderemmo il riferimento
    // senza aver davvero liberato lo spazio su R2. Riproverà al prossimo render_job completato
    // per lo stesso video (es. un retry successivo).
    logger.warn("Pulizia sorgente da R2 fallita, riprovo alla prossima occasione", {
      videoId,
      storagePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const { error: updateError } = await supabase.from("videos").update({ storage_path: null }).eq("id", videoId);
  if (updateError) {
    logger.warn("Azzeramento storage_path fallito dopo pulizia R2 (il file su R2 è comunque già stato eliminato)", {
      videoId,
      error: updateError.message,
    });
  }

  await invalidateSourceCache(storagePath);

  logger.info("Sorgente video ripulita da R2 e dalla cache locale (tutte le clip sono terminali)", { videoId, storagePath });
}

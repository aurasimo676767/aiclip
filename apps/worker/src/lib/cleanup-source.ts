import { supabase } from "./supabase.js";
import { storageProvider } from "./providers.js";
import { logger } from "./logger.js";
import { invalidateSourceCache, invalidateRedownloadCache } from "./source-download-cache.js";

/**
 * Cancella il sorgente di un video OVUNQUE (R2 + cache locale, sia quella "normale" sia quella di
 * redownload-source.ts) — usato dal tasto manuale "Elimina sorgente" in dashboard. Prima questa
 * pulizia scattava DA SOLA appena tutte le clip di un video diventavano terminali, per risparmiare
 * spazio: ma se poi si tornava sullo stesso video per generare altre clip, serviva un giro
 * completo di ri-download da YouTube + ri-upload su R2 + ri-download locale, anche ore di attesa
 * per un VOD grosso — osservato in pratica causare frustrazione ripetuta. Ora la cancellazione
 * avviene SOLO quando l'utente la chiede esplicitamente.
 */
export async function deleteVideoSourceEverywhere(videoId: string): Promise<void> {
  await invalidateRedownloadCache(videoId);

  const { data: video, error: videoError } = await supabase.from("videos").select("id, storage_path").eq("id", videoId).single();
  if (videoError || !video) {
    logger.warn("Cancellazione sorgente richiesta ma video non trovato", { videoId, error: videoError?.message });
    return;
  }

  if (!video.storage_path) {
    logger.info("Cancellazione sorgente richiesta: nessun file su R2 (già assente)", { videoId });
    return;
  }

  const storagePath = video.storage_path;

  try {
    await storageProvider.remove(storagePath);
  } catch (err) {
    logger.warn("Cancellazione sorgente da R2 fallita, riprovo alla prossima occasione", {
      videoId,
      storagePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const { error: updateError } = await supabase.from("videos").update({ storage_path: null }).eq("id", videoId);
  if (updateError) {
    logger.warn("Azzeramento storage_path fallito dopo cancellazione da R2 (il file su R2 è comunque già stato eliminato)", {
      videoId,
      error: updateError.message,
    });
  }

  await invalidateSourceCache(storagePath);

  logger.info("Sorgente video cancellato ovunque (R2 + cache locale) su richiesta dell'utente", { videoId, storagePath });
}

/**
 * Loop di polling: esegue le richieste di cancellazione manuale del sorgente arrivate dal tasto
 * in dashboard (videos.delete_source_requested_at). Vedi index.ts per l'intervallo di polling.
 */
export async function processSourceDeleteRequests(): Promise<void> {
  const { data: videos, error } = await supabase
    .from("videos")
    .select("id")
    .not("delete_source_requested_at", "is", null)
    .limit(5);
  if (error) {
    logger.error("Lettura richieste di cancellazione sorgente fallita", { error: error.message });
    return;
  }
  if (!videos || videos.length === 0) return;

  for (const video of videos) {
    try {
      await deleteVideoSourceEverywhere(video.id);
    } finally {
      // Azzerato SEMPRE, anche se la cancellazione R2 è fallita (deleteVideoSourceEverywhere logga
      // già l'errore): altrimenti una R2 irraggiungibile bloccherebbe il loop a ritentare lo stesso
      // video in eterno invece di lasciare che l'utente riprovi cliccando di nuovo il tasto.
      const { error: clearError } = await supabase.from("videos").update({ delete_source_requested_at: null }).eq("id", video.id);
      if (clearError) {
        logger.warn("Azzeramento delete_source_requested_at fallito", { videoId: video.id, error: clearError.message });
      }
    }
  }
}

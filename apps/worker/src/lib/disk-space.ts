import fsp from "node:fs/promises";

// Stima VOLUTAMENTE prudente: un VOD Twitch 1080p può arrivare a ~10 Mbit/s nei momenti più
// pesanti (gameplay veloce). Il fattore SAFETY_MULTIPLIER copre sia il margine sopra la media
// reale sia il fatto che durante il remux finale (vedi download-youtube.ts) il file scaricato e
// la sua copia rimuxata convivono per qualche minuto sullo stesso disco, quasi raddoppiando lo
// spazio realmente occupato in quel momento — è esattamente lo scenario che ha fatto esaurire lo
// spazio ed è arrivato a un crash yt-dlp incomprensibile ("Failed to extract ... .pyd") dopo
// un'ora di download invece di un errore chiaro in pochi secondi (osservato in pratica su un
// VOD di ~10h che aveva già scaricato 28.8GB prima di schiantarsi con solo 36GB liberi).
const ESTIMATED_MAX_BYTES_PER_SECOND = 1.25 * 1024 * 1024; // ~10 Mbit/s
const SAFETY_MULTIPLIER = 2.2;
const MIN_SAFETY_MARGIN_BYTES = 5 * 1024 * 1024 * 1024; // 5GB fissi, sempre in aggiunta alla stima

/**
 * Controllo preventivo, da chiamare PRIMA di iniziare un download potenzialmente enorme (VOD
 * long-form, anche ore): se lo spazio libero sul disco che ospita `targetDir` è chiaramente
 * insufficiente per la stima prudente, fallisce subito con un messaggio chiaro invece di scoprirlo
 * dopo un download lungo (rete + tempo sprecati, e su un video in coda per l'analisi anche i
 * tentativi automatici di retry, che riprendono dal punto in cui erano arrivati — vedi
 * process-video-job.ts — finiscono per sprecarsi tutti sullo stesso identico problema).
 */
export async function ensureEnoughDiskSpaceForDownload(targetDir: string, durationSeconds: number): Promise<void> {
  const estimatedBytes = durationSeconds * ESTIMATED_MAX_BYTES_PER_SECOND * SAFETY_MULTIPLIER + MIN_SAFETY_MARGIN_BYTES;

  const stats = await fsp.statfs(targetDir);
  const freeBytes = stats.bavail * stats.bsize;

  if (freeBytes < estimatedBytes) {
    const freeGB = (freeBytes / 1024 ** 3).toFixed(1);
    const neededGB = (estimatedBytes / 1024 ** 3).toFixed(1);
    const hours = (durationSeconds / 3600).toFixed(1);
    throw new Error(
      `Spazio su disco insufficiente per scaricare questo video (${hours}h): servirebbero circa ${neededGB}GB liberi (stima prudente), ne hai solo ${freeGB}GB. Libera spazio prima di riprovare.`,
    );
  }
}

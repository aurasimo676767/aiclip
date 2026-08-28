import fsp from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { StorageProvider } from "../storage/storage-provider.js";
import { env } from "../env.js";
import { logger } from "./logger.js";

// Prima ogni render_job scaricava una copia propria del video sorgente in una cartella temporanea
// dedicata (render-<jobId>) — innocuo per una clip breve, ma per un VOD long-form (20+ GB) due
// render della STESSA clip/video partiti insieme (RENDER_CONCURRENCY > 1) finivano per scaricare
// ~40GB in parallelo sulla stessa macchina, osservato causare crash ("aborted") su una macchina
// con poca RAM libera. Questa cache condivisa (per storage_path, non per render_job) fa sì che il
// secondo render in arrivo aspetti lo stesso download invece di duplicarlo.
//
// I file scaricati qui vengono ripuliti da cleanup-source.ts quando tutte le clip di un video
// sono terminali (COMPLETED/FAILED) — vedi invalidateSourceCache sotto.
const inFlightDownloads = new Map<string, Promise<string>>();

function cacheFilePath(storagePath: string): string {
  const hash = crypto.createHash("sha256").update(storagePath).digest("hex").slice(0, 16);
  const ext = path.extname(storagePath) || ".mp4";
  return path.join(env.WORKER_TMP_DIR, "source-cache", `${hash}${ext}`);
}

/**
 * Come storageProvider.downloadToFile, ma deduplica download concorrenti dello stesso
 * storagePath: se un altro render è già in corso a scaricarlo, aspetta quello invece di
 * avviarne uno nuovo.
 */
export async function getOrDownloadSourceFile(storageProvider: StorageProvider, storagePath: string): Promise<string> {
  const existing = inFlightDownloads.get(storagePath);
  if (existing) {
    return existing;
  }

  const localPath = cacheFilePath(storagePath);
  const downloadPromise = (async () => {
    await storageProvider.downloadToFile(storagePath, localPath);
    return localPath;
  })().catch((err) => {
    // Se il download fallisce, non lasciamo la entry "avvelenata" in cache per sempre: un
    // prossimo render dello stesso storagePath deve poter ritentare da zero.
    inFlightDownloads.delete(storagePath);
    throw err;
  });

  inFlightDownloads.set(storagePath, downloadPromise);
  return downloadPromise;
}

/**
 * Rimuove la copia locale in cache di un storagePath (e la entry in memoria, se presente) — usato
 * dopo che il sorgente non serve più a nessuna clip del video (vedi cleanup-source.ts). Non fallisce
 * se il file non esiste già (es. mai scaricato su questa macchina).
 */
export async function invalidateSourceCache(storagePath: string): Promise<void> {
  inFlightDownloads.delete(storagePath);
  const localPath = cacheFilePath(storagePath);
  await fsp.rm(localPath, { force: true }).catch((err) => {
    logger.warn("Rimozione cache locale sorgente fallita", { storagePath, localPath, error: err instanceof Error ? err.message : String(err) });
  });
}

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
    await pruneSourceCache(localPath).catch((err) => logger.warn("Pulizia cache sorgenti fallita", { error: err instanceof Error ? err.message : String(err) }));
    await storageProvider.downloadToFile(storagePath, localPath);
    // Ultimo utilizzo = data del file: la pulizia butta prima quelli usati meno di recente.
    const now = new Date();
    await fsp.utimes(localPath, now, now).catch(() => undefined);
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

/** Sorgenti in cache non usati da più di così si cancellano (si riscaricano da R2 se servono). */
const CACHE_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
/** Oltre questo totale si cancellano i meno usati di recente (un VOD è 15-25 GB, il disco del PC è piccolo). */
const CACHE_MAX_BYTES = 50 * 1024 ** 3;

/**
 * Tiene la cache dei sorgenti sotto controllo: il 2026-10-01 era arrivata a 86 GB (VOD da 15-25 GB
 * mai cancellati) su un SSD che rallenta tutto il PC quando è pieno. Cancella i file non usati da 3
 * giorni e, se serve, i meno usati di recente fino a stare sotto 50 GB. Mai quello che sta per essere
 * usato né quelli in download.
 */
async function pruneSourceCache(keepPath: string): Promise<void> {
  const dir = path.join(env.WORKER_TMP_DIR, "source-cache");
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const busy = new Set([keepPath, ...[...inFlightDownloads.keys()].map(cacheFilePath)]);
  const files: Array<{ p: string; size: number; mtime: number }> = [];
  for (const name of names) {
    if (name.endsWith(".complete") || name.startsWith("redownload-")) continue;
    const p = path.join(dir, name);
    if (busy.has(p)) continue;
    const st = await fsp.stat(p).catch(() => null);
    if (st?.isFile()) files.push({ p, size: st.size, mtime: st.mtimeMs });
  }
  files.sort((a, b) => a.mtime - b.mtime);
  let total = files.reduce((t, f) => t + f.size, 0);
  for (const f of files) {
    if (Date.now() - f.mtime < CACHE_MAX_AGE_MS && total <= CACHE_MAX_BYTES) break;
    await fsp.rm(f.p, { force: true }).catch(() => undefined);
    await fsp.rm(`${f.p}.complete`, { force: true }).catch(() => undefined);
    total -= f.size;
    logger.info("Cache sorgenti: cancellato un file vecchio", { file: path.basename(f.p), gb: (f.size / 1024 ** 3).toFixed(1) });
  }
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
  // Marcatore di completamento del download a blocchi paralleli (vedi r2-storage-provider.ts) —
  // va ripulito insieme al file, altrimenti un futuro download con lo stesso path locale (hash
  // deterministico su storagePath) potrebbe trovarlo e credersi già completo.
  await fsp.rm(`${localPath}.complete`, { force: true }).catch(() => undefined);
}

/**
 * Cartella STABILE (per video.id, non per render_job.id) dove far scaricare yt-dlp quando il
 * sorgente va ripreso dalla piattaforma originale (storage_path nullo — vedi redownload-source.ts).
 * Prima ogni render_job usava la propria cartella temporanea: interrompere il worker a metà di un
 * download da ore (o riavviare il PC) buttava via tutto il progresso, perché il retry successivo
 * scriveva altrove e yt-dlp non aveva un file .part da riprendere. Con un percorso fisso per
 * video.id, yt-dlp riprende da solo i frammenti già scaricati (stesso meccanismo già usato per il
 * download da R2 sopra) — osservato in pratica: un riavvio a metà di un download da 19GB su un
 * VOD di 5h+ non deve ripartire da zero.
 */
function redownloadCacheDir(videoId: string): string {
  return path.join(env.WORKER_TMP_DIR, "source-cache", `redownload-${videoId}`);
}

const inFlightRedownloads = new Map<string, Promise<string>>();

/**
 * Come getOrDownloadSourceFile, ma per il caso "ripristina da yt-dlp" invece che "scarica da R2":
 * deduplica redownload concorrenti dello stesso video E fa sì che un redownload interrotto (worker
 * ucciso, PC riavviato) riprenda dal punto in cui era arrivato invece di ripartire da zero, perché
 * `download` scrive sempre nella stessa cartella stabile per questo video.id.
 */
export async function getOrRedownloadFromPlatform(videoId: string, download: (targetDir: string) => Promise<string>): Promise<string> {
  const existing = inFlightRedownloads.get(videoId);
  if (existing) {
    return existing;
  }

  const targetDir = redownloadCacheDir(videoId);
  const downloadPromise = (async () => {
    await fsp.mkdir(targetDir, { recursive: true });
    return download(targetDir);
  })().catch((err) => {
    inFlightRedownloads.delete(videoId);
    throw err;
  });

  inFlightRedownloads.set(videoId, downloadPromise);
  return downloadPromise;
}

/** Ripulisce la cartella di redownload di un video — chiamato dopo l'upload su R2 (non serve più) o dopo un fallimento definitivo. */
export async function invalidateRedownloadCache(videoId: string): Promise<void> {
  inFlightRedownloads.delete(videoId);
  await fsp.rm(redownloadCacheDir(videoId), { recursive: true, force: true }).catch((err) => {
    logger.warn("Rimozione cache locale di redownload fallita", { videoId, error: err instanceof Error ? err.message : String(err) });
  });
}

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageProvider } from "./storage-provider.js";
import { logger } from "../lib/logger.js";

const DOWNLOAD_MAX_ATTEMPTS = 5;
const DOWNLOAD_RETRY_DELAY_MS = 5000;

// Sopra questa soglia il download passa da un singolo stream HTTP a più richieste Range in
// parallelo (stesso principio dell'upload multipart già usato in uploadFile) — un singolo stream
// su un VOD da 20GB era osservato fermarsi a ~3MB/s pur avendo una connessione capace di molto di
// più, perché una sola connessione TCP non satura la banda disponibile verso R2.
const PARALLEL_DOWNLOAD_THRESHOLD_BYTES = 200 * 1024 * 1024; // 200MB
// Dimensione FISSA di ogni blocco, non "remoteSize / concorrenza": bug reale osservato con blocchi
// da remoteSize/6 (su un VOD da 21GB, ~3.6GB l'uno) — una richiesta Range così a lungo tenuta
// aperta va in "aborted" (stesso problema del vecchio stream singolo, vedi sopra) e il retry
// ributtava via GIGABYTE di progresso per rifare l'intero blocco. Con blocchi piccoli un "aborted"
// costa secondi, non ore.
const PARALLEL_PART_SIZE_BYTES = 64 * 1024 * 1024; // 64MB
const PARALLEL_DOWNLOAD_CONCURRENCY = 6;
const PARALLEL_PART_MAX_ATTEMPTS = 5;
const PARALLEL_PART_RETRY_DELAY_MS = 3000;

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * Implementazione di StorageProvider su Cloudflare R2 (API compatibile S3).
 * Sostituisce SupabaseStorageProvider: R2 non ha un limite di dimensione file basso come
 * il piano Free di Supabase Storage (50MB), e il free tier include 10GB di storage.
 */
export class R2StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: R2Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * Un file grosso (VOD long-form, 15-25GB) è UNA richiesta HTTP tenuta aperta per minuti: un
   * qualunque intoppo (rete, R2, pressione sul sistema locale) a metà la interrompe con un
   * generico errore "aborted" — osservato in pratica, sempre e solo su download di questo tipo,
   * mai su file piccoli. Riprova fino a DOWNLOAD_MAX_ATTEMPTS volte, e da un tentativo all'altro
   * RIPRENDE da dove si era fermata (Range HTTP sui byte già scritti) invece di ripartire da
   * zero — un fallimento a 20 minuti su un download da 25 minuti non deve buttare via il lavoro
   * già fatto.
   */
  async downloadToFile(storagePath: string, localFilePath: string): Promise<void> {
    await fsp.mkdir(path.dirname(localFilePath), { recursive: true });

    // Bug reale osservato: un file locale già completo (es. da un tentativo precedente andato a
    // buon fine, magari in una cache condivisa mai ripulita) faceva comunque partire una
    // richiesta "dammi i byte da fine-file in poi" — R2 la rifiuta con 416 "range not
    // satisfiable" perché quei byte non esistono. Controllare la dimensione REALE remota prima
    // (HEAD, economico) evita sia questo errore sia un ri-download totalmente inutile.
    let remoteSize: number | null = null;
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: storagePath }));
      remoteSize = head.ContentLength ?? null;
    } catch {
      // Se anche l'HEAD fallisce non blocchiamo qui: il GetObject sotto darà comunque un errore
      // chiaro (es. file non trovato) se il problema è reale.
    }

    if (remoteSize !== null && remoteSize >= PARALLEL_DOWNLOAD_THRESHOLD_BYTES) {
      // Percorso a blocchi paralleli: la dimensione del file NON è un indicatore affidabile di
      // "quanto è stato scaricato davvero", perché il file viene preallocato (troncato) alla
      // dimensione finale prima ancora di scrivere i blocchi — un riavvio a metà lo troverebbe
      // già della dimensione giusta ma pieno di zeri non scaricati. Per questo qui il "già fatto"
      // si verifica con un marcatore scritto SOLO a download completato, non con fs.stat.
      await this.downloadInParallelParts(storagePath, localFilePath, remoteSize);
      return;
    }

    let existingBytesUpfront = 0;
    try {
      existingBytesUpfront = (await fsp.stat(localFilePath)).size;
    } catch {
      existingBytesUpfront = 0;
    }
    if (remoteSize !== null && existingBytesUpfront >= remoteSize) {
      // Già tutto scaricato in un tentativo precedente: nessun byte in più da chiedere.
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
      let existingBytes = 0;
      try {
        existingBytes = (await fsp.stat(localFilePath)).size;
      } catch {
        existingBytes = 0;
      }

      if (remoteSize !== null && existingBytes >= remoteSize) {
        // Già tutto scaricato in un tentativo precedente: nessun byte in più da chiedere.
        return;
      }

      try {
        const response = await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: storagePath,
            ...(existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {}),
          }),
        );
        if (!response.Body) {
          throw new Error(`Download storage fallito per "${storagePath}": corpo della risposta vuoto`);
        }
        const writeStream = fs.createWriteStream(localFilePath, { flags: existingBytes > 0 ? "a" : "w" });
        await pipeline(response.Body as NodeJS.ReadableStream, writeStream);
        return;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("Download da storage interrotto, ritento", {
          storagePath,
          attempt,
          maxAttempts: DOWNLOAD_MAX_ATTEMPTS,
          error: message,
        });
        if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
          await sleep(DOWNLOAD_RETRY_DELAY_MS);
        }
      }
    }

    throw new Error(
      `Download da storage fallito per "${storagePath}" dopo ${DOWNLOAD_MAX_ATTEMPTS} tentativi: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /**
   * Scarica un file grande a blocchi in parallelo (richieste Range concorrenti su connessioni TCP
   * separate) invece che con un unico stream sequenziale — su un VOD da 20+GB, un singolo stream
   * era osservato bloccarsi a ~3MB/s. Ogni blocco scrive alla propria posizione nel file (via
   * `start` di createWriteStream su un file preallocato con la dimensione finale) e viene ritentato
   * autonomamente in caso di errore, senza dover rifare i blocchi già completati.
   */
  private async downloadInParallelParts(storagePath: string, localFilePath: string, remoteSize: number): Promise<void> {
    const markerPath = `${localFilePath}.complete`;

    // Il marcatore si scrive SOLO a download riuscito (vedi in fondo): se combacia con la
    // dimensione remota attuale, il file locale è per davvero completo e non c'è nulla da rifare.
    try {
      const markerContent = await fsp.readFile(markerPath, "utf8");
      if (Number(markerContent.trim()) === remoteSize) {
        const stat = await fsp.stat(localFilePath).catch(() => null);
        if (stat && stat.size === remoteSize) {
          return;
        }
      }
    } catch {
      // Nessun marcatore: procedi con il download.
    }

    // Non tentiamo di riprendere un download a blocchi interrotto a metà (richiederebbe tracciare
    // quali blocchi erano già completi): un riavvio a metà semplicemente ricomincia il download
    // parallelo da capo, accettabile perché è comunque molto più veloce di un singolo stream.
    // "w" tronca subito il file a 0 byte prima di riallocarlo alla dimensione finale.
    const fh = await fsp.open(localFilePath, "w");
    await fh.truncate(remoteSize);
    await fh.close();
    await fsp.rm(markerPath, { force: true });

    const ranges: Array<[number, number]> = [];
    for (let start = 0; start < remoteSize; start += PARALLEL_PART_SIZE_BYTES) {
      ranges.push([start, Math.min(start + PARALLEL_PART_SIZE_BYTES, remoteSize) - 1]);
    }

    logger.info("Download parallelo a blocchi avviato", {
      storagePath,
      remoteSize,
      parts: ranges.length,
      partSize: PARALLEL_PART_SIZE_BYTES,
      concurrency: PARALLEL_DOWNLOAD_CONCURRENCY,
    });

    let nextIndex = 0;
    let completedParts = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex++;
        const range = ranges[index];
        if (!range) return;
        const [start, end] = range;
        await this.downloadRangeWithRetry(storagePath, localFilePath, start, end);
        completedParts++;
        if (completedParts % 50 === 0 || completedParts === ranges.length) {
          logger.info("Download parallelo a blocchi: avanzamento", {
            storagePath,
            completedParts,
            totalParts: ranges.length,
            percent: Math.round((completedParts / ranges.length) * 100),
          });
        }
      }
    };

    const concurrency = Math.min(PARALLEL_DOWNLOAD_CONCURRENCY, ranges.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    // Marca il download come davvero completo SOLO ora che ogni blocco è stato scritto: è quello
    // che il controllo in cima a questa funzione verifica prima di saltare un futuro tentativo.
    await fsp.writeFile(markerPath, String(remoteSize), "utf8");

    logger.info("Download parallelo a blocchi completato", { storagePath, remoteSize });
  }

  private async downloadRangeWithRetry(storagePath: string, localFilePath: string, start: number, end: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PARALLEL_PART_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: storagePath, Range: `bytes=${start}-${end}` }),
        );
        if (!response.Body) {
          throw new Error(`Blocco vuoto per "${storagePath}" (bytes ${start}-${end})`);
        }
        const writeStream = fs.createWriteStream(localFilePath, { flags: "r+", start });
        await pipeline(response.Body as NodeJS.ReadableStream, writeStream);
        return;
      } catch (err) {
        lastError = err;
        logger.warn("Blocco di download parallelo fallito, ritento", {
          storagePath,
          start,
          end,
          attempt,
          maxAttempts: PARALLEL_PART_MAX_ATTEMPTS,
          error: err instanceof Error ? err.message : String(err),
        });
        if (attempt < PARALLEL_PART_MAX_ATTEMPTS) {
          await sleep(PARALLEL_PART_RETRY_DELAY_MS);
        }
      }
    }
    throw new Error(
      `Download del blocco ${start}-${end} fallito per "${storagePath}" dopo ${PARALLEL_PART_MAX_ATTEMPTS} tentativi: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  async uploadFile(localFilePath: string, storagePath: string, contentType: string): Promise<string> {
    // Upload multipart in streaming: leggere l'intero file in memoria con fsp.readFile e fare un
    // singolo PutObjectCommand (come prima) fallisce sopra i 2GiB — un VOD Twitch di ore può
    // pesare 15-25GB. @aws-sdk/lib-storage carica a blocchi da disco senza mai tenere l'intero
    // file in RAM, e gestisce da sola la logica multipart S3-compatibile (R2 la supporta).
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: storagePath,
        Body: fs.createReadStream(localFilePath),
        ContentType: contentType,
      },
      queueSize: 4,
      partSize: 50 * 1024 * 1024, // 50MB a parte
    });
    await upload.done();
    return storagePath;
  }

  async getSignedUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: storagePath });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async remove(storagePath: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storagePath }));
  }
}

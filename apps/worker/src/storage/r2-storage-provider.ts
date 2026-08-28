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

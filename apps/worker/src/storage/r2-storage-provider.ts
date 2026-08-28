import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageProvider } from "./storage-provider.js";

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

  async downloadToFile(storagePath: string, localFilePath: string): Promise<void> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storagePath }));
    if (!response.Body) {
      throw new Error(`Download storage fallito per "${storagePath}": corpo della risposta vuoto`);
    }
    await fsp.mkdir(path.dirname(localFilePath), { recursive: true });
    await pipeline(response.Body as NodeJS.ReadableStream, fs.createWriteStream(localFilePath));
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

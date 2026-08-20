import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ServiceRoleClient } from "@clipforge/db";
import type { StorageProvider } from "./storage-provider.js";

/**
 * Implementazione StorageProvider su Supabase Storage. Non più usata di default (vedi
 * r2-storage-provider.ts) — il piano Free di Supabase limita ogni file a 50MB, troppo poco
 * per video sorgente. Lasciata qui come dimostrazione che il provider di storage è
 * realmente sostituibile: per tornare a Supabase basta cambiare l'istanza in lib/providers.ts.
 */
export class SupabaseStorageProvider implements StorageProvider {
  constructor(
    private readonly client: ServiceRoleClient,
    private readonly bucket: string,
  ) {}

  async downloadToFile(storagePath: string, localFilePath: string): Promise<void> {
    const { data, error } = await this.client.storage.from(this.bucket).download(storagePath);
    if (error || !data) {
      throw new Error(`Download storage fallito per "${storagePath}": ${error?.message ?? "nessun dato"}`);
    }
    await fsp.mkdir(path.dirname(localFilePath), { recursive: true });
    const buffer = Buffer.from(await data.arrayBuffer());
    await fsp.writeFile(localFilePath, buffer);
  }

  async uploadFile(localFilePath: string, storagePath: string, contentType: string): Promise<string> {
    const fileBuffer = await fsp.readFile(localFilePath);
    const { error } = await this.client.storage.from(this.bucket).upload(storagePath, fileBuffer, {
      contentType,
      upsert: true,
    });
    if (error) {
      const hint = /maximum allowed size/i.test(error.message)
        ? ' — alza il "File size limit" del bucket in Supabase (Storage → bucket → Edit) o riduci la qualità sorgente'
        : "";
      throw new Error(`Upload storage fallito per "${storagePath}": ${error.message}${hint}`);
    }
    return storagePath;
  }

  async getSignedUrl(storagePath: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(storagePath, expiresInSeconds);
    if (error || !data) {
      throw new Error(`Impossibile generare signed URL per "${storagePath}": ${error?.message ?? "nessun dato"}`);
    }
    return data.signedUrl;
  }

  async remove(storagePath: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([storagePath]);
    if (error) {
      throw new Error(`Rimozione storage fallita per "${storagePath}": ${error.message}`);
    }
  }
}

/** Verifica che una directory locale esista (creandola se necessario) — utile per i path temporanei del worker. */
export async function ensureDir(dirPath: string): Promise<void> {
  if (!fs.existsSync(dirPath)) {
    await fsp.mkdir(dirPath, { recursive: true });
  }
}

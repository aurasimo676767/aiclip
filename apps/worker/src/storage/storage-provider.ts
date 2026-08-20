/**
 * Astrazione sul backend di storage dei file (video sorgente, clip renderizzate, thumbnail).
 * Implementazione di default: Supabase Storage (vedi supabase-storage-provider.ts).
 * Sostituibile con Cloudflare R2/S3 implementando la stessa interfaccia, senza toccare
 * il resto della pipeline che dipende solo da questo contratto.
 */
export interface StorageProvider {
  /** Scarica un file dallo storage remoto verso un path locale sul filesystem del worker. */
  downloadToFile(storagePath: string, localFilePath: string): Promise<void>;

  /** Carica un file locale nello storage remoto al path indicato, ritorna lo storage path finale. */
  uploadFile(localFilePath: string, storagePath: string, contentType: string): Promise<string>;

  /** URL firmato temporaneo per servire/scaricare il file (usato dal frontend per preview/download). */
  getSignedUrl(storagePath: string, expiresInSeconds: number): Promise<string>;

  remove(storagePath: string): Promise<void>;
}

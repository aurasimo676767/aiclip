import "server-only";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function getClient(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY mancanti nell'ambiente server");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) {
    throw new Error("R2_BUCKET mancante nell'ambiente server");
  }
  return bucket;
}

/** URL firmato temporaneo per caricare un file direttamente dal browser a R2 (PUT), senza passare dal server Next.js. */
export async function getPresignedUploadUrl(storagePath: string, contentType: string, expiresInSeconds = 3600): Promise<string> {
  const client = getClient();
  const command = new PutObjectCommand({ Bucket: getBucket(), Key: storagePath, ContentType: contentType });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

/**
 * La firma parte dall'inizio dell'ora in corso, non da adesso: così ogni richiesta nella stessa ora
 * dà lo STESSO URL. Prima l'URL cambiava a ogni ricarica della pagina (che si aggiorna da sola ogni
 * 4s mentre c'è qualcosa in lavorazione), il player vedeva un video "nuovo" e ripartiva da capo —
 * si bloccava dopo un secondo e mezzo (2026-09-25). Un URL stabile fa anche usare la cache del
 * browser.
 */
const SIGNING_WINDOW_SECONDS = 3600;

/** URL firmato temporaneo per scaricare/riprodurre un file da R2 (GET), valido almeno `expiresInSeconds` da adesso. */
export async function getPresignedDownloadUrl(storagePath: string, expiresInSeconds = 3600): Promise<string> {
  const client = getClient();
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: storagePath });
  const windowMs = SIGNING_WINDOW_SECONDS * 1000;
  const signingDate = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds + SIGNING_WINDOW_SECONDS, signingDate });
}

/** Legge un file di testo da R2 (null se non esiste). Usato per piccoli indici JSON (libreria facce). */
export async function readTextObject(storagePath: string): Promise<string | null> {
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: getBucket(), Key: storagePath }));
    return (await res.Body?.transformToString("utf-8")) ?? null;
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") return null;
    throw error;
  }
}

export async function writeTextObject(storagePath: string, body: string, contentType = "application/json"): Promise<void> {
  await getClient().send(new PutObjectCommand({ Bucket: getBucket(), Key: storagePath, Body: body, ContentType: contentType }));
}

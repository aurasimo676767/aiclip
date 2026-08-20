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

/** URL firmato temporaneo per scaricare/riprodurre un file da R2 (GET). */
export async function getPresignedDownloadUrl(storagePath: string, expiresInSeconds = 3600): Promise<string> {
  const client = getClient();
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: storagePath });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

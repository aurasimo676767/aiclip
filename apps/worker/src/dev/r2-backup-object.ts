import "dotenv/config";
import {
  S3Client,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { env } from "../env.js";

/**
 * Copia un file su R2 dentro R2 (niente download), anche oltre i 5 GB: a pezzi da 1 GB. Serve a
 * tenere una versione di un video prima di rifarlo (es. il montato che a simo è piaciuto).
 * Uso: tsx src/dev/r2-backup-object.ts <chiave> <chiave copia>
 */
const [from, to] = process.argv.slice(2) as [string, string];
const client = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});
const head = await client.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: from }));
const size = head.ContentLength ?? 0;
const PART = 1024 * 1024 * 1024;
const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket: env.R2_BUCKET, Key: to, ContentType: head.ContentType }));
try {
  const parts: Array<{ ETag: string; PartNumber: number }> = [];
  for (let i = 0, n = 1; i < size; i += PART, n++) {
    const end = Math.min(size, i + PART) - 1;
    const res = await client.send(
      new UploadPartCopyCommand({ Bucket: env.R2_BUCKET, Key: to, UploadId, PartNumber: n, CopySource: `${env.R2_BUCKET}/${encodeURIComponent(from).replace(/%2F/g, "/")}`, CopySourceRange: `bytes=${i}-${end}` }),
    );
    parts.push({ ETag: res.CopyPartResult!.ETag!, PartNumber: n });
  }
  await client.send(new CompleteMultipartUploadCommand({ Bucket: env.R2_BUCKET, Key: to, UploadId, MultipartUpload: { Parts: parts } }));
  console.log(`copiato ${(size / 1e9).toFixed(2)} GB → ${to}`);
} catch (error) {
  await client.send(new AbortMultipartUploadCommand({ Bucket: env.R2_BUCKET, Key: to, UploadId }));
  throw error;
}

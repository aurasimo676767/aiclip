import "dotenv/config";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { env } from "../env.js";

// Quanto occupa il bucket R2, per cartella (gratis: solo elenco). Uso: tsx src/dev/r2-usage.ts
const client = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});
const byFolder = new Map<string, { n: number; bytes: number }>();
const big: Array<{ key: string; bytes: number; at: Date | undefined }> = [];
let token: string | undefined;
do {
  const res = await client.send(new ListObjectsV2Command({ Bucket: env.R2_BUCKET, ContinuationToken: token }));
  for (const o of res.Contents ?? []) {
    const folder = (o.Key ?? "").split("/").slice(0, 2).join("/");
    const x = byFolder.get(folder) ?? { n: 0, bytes: 0 };
    x.n++;
    x.bytes += o.Size ?? 0;
    byFolder.set(folder, x);
    if ((o.Size ?? 0) > 1e9) big.push({ key: o.Key!, bytes: o.Size!, at: o.LastModified });
  }
  token = res.NextContinuationToken;
} while (token);
const total = [...byFolder.values()].reduce((s, x) => s + x.bytes, 0);
console.log(`TOTALE: ${(total / 1e9).toFixed(1)} GB (gratis fino a 10 GB, poi ~$0,015 per GB al mese)`);
for (const [f, x] of [...byFolder.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12)) console.log(`${(x.bytes / 1e9).toFixed(1).padStart(7)} GB  ${String(x.n).padStart(5)} file  ${f}`);
console.log("File oltre 1 GB:");
for (const b of big.sort((a, b) => b.bytes - a.bytes).slice(0, 15)) console.log(`${(b.bytes / 1e9).toFixed(1).padStart(6)} GB  ${b.at?.toISOString().slice(0, 10)}  ${b.key}`);

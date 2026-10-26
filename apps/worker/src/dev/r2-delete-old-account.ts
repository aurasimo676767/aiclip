import "dotenv/config";
import fs from "node:fs";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { env } from "../env.js";

/**
 * Cancella da R2 i VOD sorgenti (videos/) e le clip montate (clips/) dell'account vecchio, perso col
 * database il 2026-10-25 (simo: "sì cancella"). Tiene tutto ciò che appartiene ai progetti e
 * all'utente nuovi, e non tocca mai face-library/ né le altre cartelle. Senza "--vai" conta soltanto.
 * Uso: tsx src/dev/r2-delete-old-account.ts <file id progetti nuovi> <id utente nuovo> [--vai]
 */
const [projectsFile, newUserId, go] = process.argv.slice(2);
const keep = new Set([...fs.readFileSync(projectsFile!, "utf8").trim().split(","), newUserId!]);
if (keep.size < 2 || !newUserId) throw new Error("Mancano gli id da tenere");
const client = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});

const doomed: Array<{ Key: string }> = [];
let bytes = 0;
let token: string | undefined;
do {
  const res = await client.send(new ListObjectsV2Command({ Bucket: env.R2_BUCKET, ContinuationToken: token }));
  for (const o of res.Contents ?? []) {
    const [top, owner] = (o.Key ?? "").split("/");
    if ((top === "videos" || top === "clips") && owner && !keep.has(owner)) {
      doomed.push({ Key: o.Key! });
      bytes += o.Size ?? 0;
    }
  }
  token = res.NextContinuationToken;
} while (token);
console.log(`${go === "--vai" ? "Cancello" : "Da cancellare"}: ${doomed.length} file, ${(bytes / 1e9).toFixed(1)} GB`);

if (go === "--vai") {
  let deleted = 0;
  for (let i = 0; i < doomed.length; i += 1000) {
    const res = await client.send(new DeleteObjectsCommand({ Bucket: env.R2_BUCKET, Delete: { Objects: doomed.slice(i, i + 1000), Quiet: true } }));
    if (res.Errors?.length) console.log("Errori:", JSON.stringify(res.Errors.slice(0, 5)));
    deleted += Math.min(1000, doomed.length - i) - (res.Errors?.length ?? 0);
  }
  console.log(`Cancellati ${deleted} file`);
}

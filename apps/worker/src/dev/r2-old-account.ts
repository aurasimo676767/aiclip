import "dotenv/config";
import fs from "node:fs";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { env } from "../env.js";

/**
 * Quanto spazio su R2 è dell'account vecchio (database perso il 2026-10-25) e quanto di quello nuovo.
 * Si tiene SEMPRE face-library/ (le foto delle facce stanno ancora sotto l'id vecchio). Gratis.
 * Uso: tsx src/dev/r2-old-account.ts <file con gli id dei progetti nuovi, separati da virgola> <id utente nuovo>
 */
const [projectsFile, newUserId] = process.argv.slice(2);
const keepProjects = new Set(fs.readFileSync(projectsFile!, "utf8").trim().split(","));
const client = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});
const sums = { vecchioVod: 0, vecchieClip: 0, vecchiAltro: 0, nuovo: 0, facce: 0 };
const counts = { vecchioVod: 0, vecchieClip: 0, vecchiAltro: 0, nuovo: 0, facce: 0 };
let token: string | undefined;
do {
  const res = await client.send(new ListObjectsV2Command({ Bucket: env.R2_BUCKET, ContinuationToken: token }));
  for (const o of res.Contents ?? []) {
    const [top, owner] = (o.Key ?? "").split("/");
    const kind: keyof typeof sums =
      top === "face-library" ? "facce"
      : owner === newUserId || keepProjects.has(owner ?? "") ? "nuovo"
      : top === "videos" ? "vecchioVod"
      : top === "clips" ? "vecchieClip"
      : "vecchiAltro";
    sums[kind] += o.Size ?? 0;
    counts[kind]++;
  }
  token = res.NextContinuationToken;
} while (token);
for (const k of Object.keys(sums) as Array<keyof typeof sums>) console.log(`${(sums[k] / 1e9).toFixed(1).padStart(7)} GB  ${String(counts[k]).padStart(5)} file  ${k}`);

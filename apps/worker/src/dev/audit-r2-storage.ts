import "dotenv/config";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";

const client = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});

async function listAllObjects(): Promise<Map<string, number>> {
  const objects = new Map<string, number>();
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: env.R2_BUCKET, ContinuationToken: continuationToken }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) objects.set(obj.Key, obj.Size ?? 0);
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return objects;
}

function fmtGB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2) + "GB";
}

async function main() {
  console.log("Elenco oggetti su R2...");
  const allObjects = await listAllObjects();
  const totalBytes = [...allObjects.values()].reduce((a, b) => a + b, 0);
  console.log(`Totale su R2: ${allObjects.size} oggetti, ${fmtGB(totalBytes)}\n`);

  // Video sorgenti: sicuri da cancellare SOLO se tutte le clip del video sono in stato terminale.
  const { data: videos } = await supabase.from("videos").select("id, storage_path");
  const { data: clips } = await supabase.from("clips").select("id, video_id, status, output_video_path, thumbnail_path");

  const clipsByVideo = new Map<string, typeof clips>();
  for (const c of clips ?? []) {
    const list = clipsByVideo.get(c.video_id) ?? [];
    list.push(c);
    clipsByVideo.set(c.video_id, list);
  }

  const staleSourceKeys: string[] = [];
  for (const v of videos ?? []) {
    if (!v.storage_path || !allObjects.has(v.storage_path)) continue;
    const videoClips = clipsByVideo.get(v.id) ?? [];
    const allTerminal = videoClips.length > 0 && videoClips.every((c) => c.status === "COMPLETED" || c.status === "FAILED");
    if (allTerminal) staleSourceKeys.push(v.storage_path);
  }

  // Clip già renderizzate (COMPLETED/FAILED): l'utente ha confermato che non gli servono più.
  const completedClipVideoKeys: string[] = [];
  const completedClipThumbKeys: string[] = [];
  for (const c of clips ?? []) {
    if (c.status !== "COMPLETED" && c.status !== "FAILED") continue;
    if (c.output_video_path && allObjects.has(c.output_video_path)) completedClipVideoKeys.push(c.output_video_path);
    if (c.thumbnail_path && allObjects.has(c.thumbnail_path)) completedClipThumbKeys.push(c.thumbnail_path);
  }

  // Riferimenti "vivi": tutto ciò che NON va toccato (sorgenti di video con clip ancora
  // pending, clip non ancora renderizzate/in rendering).
  const referencedKeys = new Set<string>();
  for (const v of videos ?? []) {
    if (v.storage_path) referencedKeys.add(v.storage_path);
  }
  for (const c of clips ?? []) {
    if (c.output_video_path) referencedKeys.add(c.output_video_path);
    if (c.thumbnail_path) referencedKeys.add(c.thumbnail_path);
  }

  // Oggetti su R2 che non compaiono in NESSUNA riga del database: orfani veri (upload riuscito ma
  // scrittura DB fallita, o riga cancellata a mano) — sempre sicuri da cancellare.
  const orphanKeys: string[] = [];
  for (const key of allObjects.keys()) {
    if (!referencedKeys.has(key)) orphanKeys.push(key);
  }

  const sumBytes = (keys: string[]) => keys.reduce((sum, k) => sum + (allObjects.get(k) ?? 0), 0);

  console.log(`1) Sorgenti video orfani (tutte le clip terminali): ${staleSourceKeys.length} oggetti, ${fmtGB(sumBytes(staleSourceKeys))}`);
  console.log(`2) Clip già renderizzate (COMPLETED/FAILED) - video: ${completedClipVideoKeys.length} oggetti, ${fmtGB(sumBytes(completedClipVideoKeys))}`);
  console.log(`3) Clip già renderizzate (COMPLETED/FAILED) - thumbnail: ${completedClipThumbKeys.length} oggetti, ${fmtGB(sumBytes(completedClipThumbKeys))}`);
  console.log(`4) Oggetti orfani (non referenziati da nessuna riga DB): ${orphanKeys.length} oggetti, ${fmtGB(sumBytes(orphanKeys))}`);

  const totalReclaimable = new Set([...staleSourceKeys, ...completedClipVideoKeys, ...completedClipThumbKeys, ...orphanKeys]);
  console.log(`\nTOTALE recuperabile: ${totalReclaimable.size} oggetti, ${fmtGB(sumBytes([...totalReclaimable]))}`);
  console.log(`Resterebbe (non toccato): ${fmtGB(totalBytes - sumBytes([...totalReclaimable]))}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

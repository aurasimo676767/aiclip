import "dotenv/config";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";

/**
 * Prova SOLO l'apertura del caricamento su TikTok (init) per una clip, con varianti del corpo, e
 * stampa la risposta intera: per capire gli errori di TikTok. Non carica né pubblica niente.
 * Uso: tsx src/dev/tiktok-init-test.ts <jobId>
 */
const { data: job } = await supabase.from("tiktok_publish_jobs").select("*").eq("id", process.argv[2]!).single();
const { data: clip } = await supabase.from("clips").select("output_video_path").eq("id", job!.clip_id).single();
const { data: conn } = await supabase.from("tiktok_connections").select("access_token,expires_at,scope").eq("user_id", job!.user_id).single();
const file = path.join(os.tmpdir(), `tt-${job!.id}.mp4`);
await storageProvider.downloadToFile(clip!.output_video_path!, file);
const size = (await fsp.stat(file)).size;
console.log(JSON.stringify({ size, scope: conn!.scope, scade: conn!.expires_at }));
const chunk = size <= 64 * 1024 * 1024 ? size : 10 * 1024 * 1024;
const count = size <= 64 * 1024 * 1024 ? 1 : Math.floor(size / chunk);
const source_info = { source: "FILE_UPLOAD", video_size: size, chunk_size: chunk, total_chunk_count: count };
const variants: Record<string, unknown> = {
  completo: { post_info: { title: job!.caption, privacy_level: job!.privacy_level, disable_comment: true, disable_duet: true, disable_stitch: true, video_cover_timestamp_ms: 1000 }, source_info },
  minimo: { post_info: { title: "test", privacy_level: "SELF_ONLY" }, source_info },
};
for (const [name, body] of Object.entries(variants)) {
  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: { Authorization: `Bearer ${conn!.access_token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  });
  console.log(name, res.status, (await res.text()).slice(0, 400));
}
await fsp.rm(file, { force: true });

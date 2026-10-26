import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Pubblicazioni YouTube/TikTok delle clip di un video (gratis, sola lettura). Uso: tsx src/dev/clip-publish-status.ts <videoId> */
const videoId = process.argv[2]!;
const { data: clips } = await supabase.from("clips").select("id, title, status").eq("video_id", videoId);
const ids = (clips ?? []).map((c) => c.id);
for (const table of ["youtube_publish_jobs", "tiktok_publish_jobs"]) {
  const { data, error } = (await supabase.from(table as "youtube_publish_jobs").select("*").in("clip_id", ids)) as unknown as { data: Array<Record<string, string>> | null; error: Error | null };
  if (error) throw error;
  for (const j of data ?? []) {
    const clip = clips!.find((c) => c.id === j.clip_id);
    console.log(table, j.status, j.publish_at ?? j.scheduled_at ?? "", j.clip_id, clip?.title);
  }
  console.log(`${table}: ${data?.length ?? 0}`);
}

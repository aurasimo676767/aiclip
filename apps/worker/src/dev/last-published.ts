import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";

/** Ultimi video pubblicati su YouTube, con clip e link firmato al file. Uso: tsx src/dev/last-published.ts [quanti] */
const { data, error } = await supabase
  .from("youtube_publish_jobs")
  .select("id,clip_id,status,youtube_video_id,created_at,completed_at")
  .eq("status", "COMPLETED")
  .order("completed_at", { ascending: false })
  .limit(Number(process.argv[2] ?? 3));
if (error) throw new Error(error.message);
for (const j of data ?? []) {
  const { data: clip } = await supabase
    .from("clips")
    .select("id,title,format,start_time,end_time,duration,longform_edit,output_video_path,video_id,status,updated_at")
    .eq("id", j.clip_id)
    .single();
  const { data: video } = await supabase.from("videos").select("id,original_filename,source_url,storage_path,duration_seconds").eq("id", clip?.video_id ?? "").single();
  console.log(JSON.stringify({ published: j.completed_at, youtube: j.youtube_video_id, clip, video }));
  if (clip?.output_video_path) console.log("URL_CLIP", await storageProvider.getSignedUrl(clip.output_video_path, 3600));
  if (video?.storage_path) console.log("URL_SOURCE", await storageProvider.getSignedUrl(video.storage_path, 3600));
}

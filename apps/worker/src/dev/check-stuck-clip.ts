import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function main() {
  const { data: clip, error: clipErr } = await supabase
    .from("clips")
    .select("id,video_id,project_id,start_time,end_time,format,status")
    .eq("id", "e7d145c6-3c17-4a60-8f55-cad6b1ef71e2")
    .single();
  if (clipErr) throw clipErr;
  console.log("clip:", clip);

  const { data: video, error: videoErr } = await supabase
    .from("videos")
    .select("id,original_filename,source_url,storage_path,duration_seconds,status")
    .eq("id", clip.video_id)
    .single();
  if (videoErr) throw videoErr;
  console.log("video:", video);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import "dotenv/config";
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";

/** Clip di un video con il file sorgente in cache. Uso: tsx src/dev/list-clips.ts <video_id> */
const [videoId] = process.argv.slice(2);
const { data: video } = await supabase.from("videos").select("storage_path").eq("id", videoId!).single();
const { data: clips } = await supabase.from("clips").select("id,start_time,end_time,title").eq("video_id", videoId!).order("start_time");
if (video?.storage_path) console.log("sorgente: tmp/source-cache/" + crypto.createHash("sha256").update(video.storage_path).digest("hex").slice(0, 16) + ".mp4");
for (const c of clips ?? []) console.log(c.id, c.start_time.toFixed(2), c.end_time.toFixed(2), c.title);

import "dotenv/config";
import { execFileSync } from "node:child_process";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";

/** Anteprima leggera (720p) di un tratto del video di una clip, letta da R2. Uso: tsx src/dev/clip-preview.ts <clipId> <da s> <durata s> <out.mp4> */
const [clipId, from, dur, out] = process.argv.slice(2);
const { data: clip } = await supabase.from("clips").select("output_video_path").eq("id", clipId!).single();
const url = await storageProvider.getSignedUrl(clip!.output_video_path!, 3600);
execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", from!, "-t", dur!, "-i", url, "-vf", "scale=1280:-2", "-c:v", "libx264", "-crf", "27", "-preset", "veryfast", "-c:a", "aac", "-b:a", "128k", out!]);
console.log("ok");

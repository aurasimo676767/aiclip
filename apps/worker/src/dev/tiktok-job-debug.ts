import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";

/** Dati di un invio TikTok e dimensione del video da caricare. Uso: tsx src/dev/tiktok-job-debug.ts <jobId> */
const { data: job } = await supabase.from("tiktok_publish_jobs").select("*").eq("id", process.argv[2]!).single();
const { data: clip } = await supabase.from("clips").select("output_video_path,format,duration").eq("id", job!.clip_id).single();
const url = await storageProvider.getSignedUrl(clip!.output_video_path!, 600);
const head = await fetch(url, { method: "HEAD" });
console.log(JSON.stringify({ privacy: job!.privacy_level, captionLen: job!.caption.length, format: clip!.format, durata: Math.round(clip!.duration), bytes: head.headers.get("content-length"), status: head.status }));

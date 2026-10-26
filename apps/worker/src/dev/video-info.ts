import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/** Info di un video e delle sue clip (gratis, sola lettura). Uso: tsx src/dev/video-info.ts <videoId> */
const videoId = process.argv[2]!;
const { data: video, error } = await supabase.from("videos").select("*").eq("id", videoId).single();
if (error) throw error;
const { storage_path, ...rest } = video as Record<string, unknown>;
console.log(JSON.stringify(rest, (k, v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v), 1));
const { data: clips } = await supabase.from("clips").select("*").eq("video_id", videoId).order("created_at", { ascending: true });
console.log("colonne clip:", Object.keys(clips?.[0] ?? {}).join(", "));
for (const c of clips ?? []) console.log(c.id, c.status, Math.round(c.start_time ?? 0), Math.round(c.end_time ?? 0), c.title);

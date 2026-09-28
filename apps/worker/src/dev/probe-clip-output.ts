import "dotenv/config";
import { execFileSync } from "node:child_process";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";

/**
 * Durata del video renderizzato di una clip e fotogrammi dei primi secondi, leggendolo da R2 senza
 * scaricarlo tutto. Uso: tsx src/dev/probe-clip-output.ts <clipId> <cartella per i fotogrammi>
 */
const [clipId, outDir] = process.argv.slice(2);
const { data: clip } = await supabase.from("clips").select("output_video_path,duration,longform_games").eq("id", clipId!).single();
const url = await storageProvider.getSignedUrl(clip!.output_video_path!, 3600);
const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", url]).toString().trim();
console.log(JSON.stringify({ taglioSecondi: Math.round(clip!.duration), videoSecondi: Math.round(Number(dur)), giochi: clip!.longform_games }));
if (outDir) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-t", "12", "-i", url, "-vf", "fps=1,scale=480:-2,tile=6x2", `${outDir}/inizio.jpg`]);
  console.log("fotogrammi salvati");
}

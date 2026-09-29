import "dotenv/config";
import { execFileSync } from "node:child_process";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";

/** Fotogrammi (tile) del video di una clip letto da R2. Uso: tsx src/dev/clip-frames.ts <clipId> <out.jpg> [secondi,secondi...] */
const [clipId, out, times = "2,6,10,14"] = process.argv.slice(2);
const { data: clip } = await supabase.from("clips").select("output_video_path").eq("id", clipId!).single();
const url = await storageProvider.getSignedUrl(clip!.output_video_path!, 3600);
const ts = times.split(",");
const inputs = ts.flatMap((t) => ["-ss", t, "-i", url]);
const filter = ts.map((_, i) => `[${i}:v]scale=360:-2,trim=end_frame=1[v${i}]`).join(";") + ";" + ts.map((_, i) => `[v${i}]`).join("") + `hstack=inputs=${ts.length}`;
execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-frames:v", "1", out!]);
console.log("ok");

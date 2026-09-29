import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";
import { env } from "../env.js";

/** Fotogramma del SORGENTE di una clip a un certo secondo della clip (cache locale o R2). Uso: tsx src/dev/clip-source-frame.ts <clipId> <sec> <out.jpg> */
const [clipId, sec, out] = process.argv.slice(2);
const { data: clip } = await supabase.from("clips").select("video_id,start_time").eq("id", clipId!).single();
const { data: video } = await supabase.from("videos").select("storage_path").eq("id", clip!.video_id).single();
const sp = video!.storage_path as string;
const local = path.join(env.WORKER_TMP_DIR, "source-cache", `${crypto.createHash("sha256").update(sp).digest("hex").slice(0, 16)}${path.extname(sp) || ".mp4"}`);
const src = fs.existsSync(local) ? local : await storageProvider.getSignedUrl(sp, 3600);
execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(clip!.start_time + Number(sec)), "-i", src, "-frames:v", "1", "-vf", "scale=960:-2", out!], { timeout: 120000 });
console.log(fs.existsSync(local) ? "da cache locale" : "da R2");

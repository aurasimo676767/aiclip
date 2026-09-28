import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";

/** Dov'è in locale il sorgente di un video (cache dei download). Uso: tsx src/dev/find-source.ts <videoId> */
const { data } = await supabase.from("videos").select("storage_path,duration_seconds").eq("id", process.argv[2]!).single();
const sp = data?.storage_path as string;
const hash = crypto.createHash("sha256").update(sp).digest("hex").slice(0, 16);
const p = path.join(env.WORKER_TMP_DIR, "source-cache", `${hash}${path.extname(sp) || ".mp4"}`);
console.log(JSON.stringify({ storage: sp, local: p, presente: fs.existsSync(p), durata: data?.duration_seconds }));

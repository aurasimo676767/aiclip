import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";

/** Sorgenti dei video: su R2 (storage_path), in cache sul PC, e clip non ancora renderizzate che ne hanno bisogno. Uso: tsx src/dev/source-inventory.ts */
const { data: videos } = await supabase.from("videos").select("id,original_filename,storage_path,size_bytes,status,created_at").order("created_at");
const cacheDir = "tmp/source-cache";
const local = new Set(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => !f.endsWith(".complete")) : []);
const known = new Set<string>();
for (const v of videos ?? []) {
  if (!v.storage_path) continue;
  const hash = crypto.createHash("sha1").update(v.storage_path).digest("hex").slice(0, 16);
  const file = [...local].find((f) => f.startsWith(hash));
  if (file) known.add(file);
  const { data: clips } = await supabase.from("clips").select("status").eq("video_id", v.id);
  const pending = (clips ?? []).filter((c) => ["SUGGESTED", "QUEUED", "RENDERING", "FAILED"].includes(c.status)).length;
  console.log(`R2 ${v.created_at.slice(0, 10)} ${v.id} ${((v.size_bytes ?? 0) / 1e9).toFixed(1)}GB ${v.status} pc=${file ? "sì" : "no"} clipNonFatte=${pending} ${(v.original_filename ?? "").slice(0, 40)}`);
}
for (const f of local) if (!known.has(f)) console.log(`SOLO-PC ${f} ${(fs.statSync(path.join(cacheDir, f)).size / 1e9).toFixed(1)}GB`);

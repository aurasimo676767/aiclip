import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { supabase } from "../lib/supabase.js";

/** A quale video appartiene ogni file in tmp/source-cache, e se le sue clip sono tutte finite. */
const files = fs.readdirSync("tmp/source-cache").filter((f) => !f.endsWith(".complete"));
const { data: videos } = await supabase.from("videos").select("id,status,storage_path,original_filename");
const byHash = new Map<string, NonNullable<typeof videos>[number]>();
for (const v of videos ?? []) {
  if (!v.storage_path) continue;
  const ext = path.extname(v.storage_path) || ".mp4";
  byHash.set(crypto.createHash("sha256").update(v.storage_path).digest("hex").slice(0, 16) + ext, v);
}
for (const f of files) {
  const v = byHash.get(f);
  const size = (fs.statSync(path.join("tmp/source-cache", f)).size / 1e9).toFixed(2);
  if (!v) {
    console.log(`${f} ${size}GB  -> nessun video (orfano)`);
    continue;
  }
  const { data: clips } = await supabase.from("clips").select("status").eq("video_id", v.id);
  const open = (clips ?? []).filter((c) => !["COMPLETED", "FAILED"].includes(c.status as string)).length;
  console.log(`${f} ${size}GB  -> ${v.id} ${v.status} "${(v.original_filename ?? "").slice(0, 40)}" clip aperte: ${open}/${clips?.length ?? 0}`);
}

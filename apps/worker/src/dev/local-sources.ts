import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";

/** Sorgenti scaricati sul PC (cache dei download e cartelle dei video), con peso e a quale video appartengono. */
const { data: videos } = await supabase.from("videos").select("id,storage_path,original_filename,streamer_name,created_at");
const byHash = new Map<string, { id: string; name: string }>();
for (const v of videos ?? []) {
  if (!v.storage_path) continue;
  const h = crypto.createHash("sha256").update(v.storage_path).digest("hex").slice(0, 16);
  byHash.set(h, { id: v.id, name: `${v.streamer_name ?? ""} — ${v.original_filename ?? ""}`.slice(0, 90) });
}
const byId = new Map((videos ?? []).map((v) => [v.id, `${v.streamer_name ?? ""} — ${v.original_filename ?? ""}`.slice(0, 90)]));
const rows: Array<{ gb: number; what: string; file: string }> = [];
const tmp = env.WORKER_TMP_DIR;
for (const f of fs.readdirSync(path.join(tmp, "source-cache"))) {
  const st = fs.statSync(path.join(tmp, "source-cache", f));
  if (!st.isFile() || st.size < 1e6) continue;
  const v = byHash.get(f.split(".")[0]!);
  rows.push({ gb: st.size / 1e9, what: v ? v.name : "?", file: `source-cache/${f}` });
}
for (const d of fs.readdirSync(tmp)) {
  const full = path.join(tmp, d);
  if (d === "source-cache" || !fs.statSync(full).isDirectory()) continue;
  let size = 0;
  for (const f of fs.readdirSync(full)) {
    const s = fs.statSync(path.join(full, f));
    if (s.isFile()) size += s.size;
  }
  if (size < 1e6) continue;
  const id = d.replace(/^video-/, "");
  rows.push({ gb: size / 1e9, what: byId.get(id) ?? d, file: d });
}
rows.sort((a, b) => b.gb - a.gb);
for (const r of rows) console.log(`${r.gb.toFixed(1).padStart(5)} GB  ${r.what}  [${r.file}]`);
console.log(`TOTALE ${rows.reduce((s, r) => s + r.gb, 0).toFixed(1)} GB`);

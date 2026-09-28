import "dotenv/config";
import os from "node:os";
import { supabase } from "../lib/supabase.js";
import { readFaceLibrary } from "../lib/face-library.js";

/** Quante foto ha ogni persona nella libreria delle facce (buone, busto, con tag). Uso: tsx src/dev/face-stats.ts */
const { data: project } = await supabase.from("projects").select("user_id").limit(1).single();
const lib = await readFaceLibrary(project!.user_id, os.tmpdir());
const by = new Map<string, { tot: number; busto: number; tags: Map<string, number> }>();
for (const f of lib.faces) {
  if (f.status !== "labeled" || !f.label) continue;
  const e = by.get(f.label) ?? { tot: 0, busto: 0, tags: new Map() };
  e.tot++;
  if (f.bust) e.busto++;
  for (const t of f.tags ?? []) e.tags.set(t, (e.tags.get(t) ?? 0) + 1);
  by.set(f.label, e);
}
for (const [k, v] of by) console.log(k, "foto:", v.tot, "busto:", v.busto, "tag:", JSON.stringify(Object.fromEntries(v.tags)));

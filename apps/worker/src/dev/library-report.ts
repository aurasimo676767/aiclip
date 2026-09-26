import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { readFaceLibrary } from "../lib/face-library.js";

/** Riepilogo della libreria facce: per nome, quante, busti, espressioni. Uso: tsx src/dev/library-report.ts <cartella di lavoro> */
const work = path.resolve(process.argv[2]!);
await fsp.mkdir(work, { recursive: true });
const { data: profile } = await supabase.from("profiles").select("id").limit(1).single();
const lib = await readFaceLibrary(profile!.id, work);
const by = new Map<string, typeof lib.faces>();
for (const f of lib.faces) {
  const key = f.status === "rejected" ? "(scartate)" : (f.label ?? "(senza nome)");
  by.set(key, [...(by.get(key) ?? []), f]);
}
for (const [k, fs] of by) console.log(k, fs.length, "busti:", fs.filter((f) => f.bust).length, "espressioni:", fs.map((f) => `${f.expression}${f.bust ? "*" : ""}`).join(" "));

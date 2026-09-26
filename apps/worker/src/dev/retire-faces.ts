import "dotenv/config";
import path from "node:path";
import fsp from "node:fs/promises";
import { supabase } from "../lib/supabase.js";
import { readFaceLibrary, writeFaceLibrary } from "../lib/face-library.js";

/**
 * Segna come "rejected" (non più usate, ma non cancellate) le facce della libreria con un certo
 * nome e una certa origine, es. per sostituirle con versioni migliori.
 * Uso: tsx src/dev/retire-faces.ts <NOME> <sourceVideoId> <cartella di lavoro>
 */
const [label, source, work] = process.argv.slice(2);
const { data: profile } = await supabase.from("profiles").select("id").limit(1).single();
await fsp.mkdir(work!, { recursive: true });
const library = await readFaceLibrary(profile!.id, path.resolve(work!));
let n = 0;
for (const f of library.faces) {
  if (f.label === label?.toUpperCase() && f.sourceVideoId === source && f.status !== "rejected") {
    f.status = "rejected";
    n++;
  }
}
await writeFaceLibrary(profile!.id, library, path.resolve(work!));
console.log(`ritirate ${n} facce di ${label}`);

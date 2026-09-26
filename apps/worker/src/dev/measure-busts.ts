import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { storageProvider } from "../lib/providers.js";
import { readFaceLibrary, writeFaceLibrary, isBustCutout, measureCutout } from "../lib/face-library.js";

/** Misura "busto o sola testa" e i lati tagliati per le facce della libreria che non ce l'hanno ancora (--again: tutte). Uso: tsx src/dev/measure-busts.ts <cartella di lavoro> [--again] */
const work = path.resolve(process.argv[2]!);
await fsp.mkdir(work, { recursive: true });
const { data: profile } = await supabase.from("profiles").select("id").limit(1).single();
const library = await readFaceLibrary(profile!.id, work);
let n = 0;
for (const f of library.faces) {
  if (f.status === "rejected" || (f.bust !== undefined && !process.argv.includes("--again"))) continue;
  const local = path.join(work, `${f.id}.png`);
  await storageProvider.downloadToFile(f.path, local);
  const png = await fsp.readFile(local);
  f.bust = await isBustCutout(png);
  const shape = await measureCutout(png);
  f.bothSidesCut = shape.cuts.left && shape.cuts.right;
  await fsp.rm(local, { force: true });
  n++;
}
await writeFaceLibrary(profile!.id, library, work);
console.log(`misurate ${n}: tagliate sui due lati ${library.faces.filter((f) => f.status !== "rejected" && f.bothSidesCut).length}, busti ${library.faces.filter((f) => f.status !== "rejected" && f.bust).length}, sole teste ${library.faces.filter((f) => f.status !== "rejected" && f.bust === false).length}`);

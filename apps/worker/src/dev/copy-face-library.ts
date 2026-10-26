import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { storageProvider } from "../lib/providers.js";
import { faceLibraryIndexKey, readFaceLibrary, type FaceLibraryIndex } from "../lib/face-library.js";

/**
 * Ricollega la libreria delle facce a un account nuovo (2026-10-25: database rifatto, l'account di
 * simo ha un id nuovo). Copia l'indice del vecchio id su quello nuovo, unendo le facce già presenti;
 * le foto restano dove sono, perché ogni faccia ha il percorso completo. Gratis, solo R2.
 * Uso: tsx src/dev/copy-face-library.ts <vecchio_user_id> <nuovo_user_id>
 */
const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error("Uso: tsx src/dev/copy-face-library.ts <vecchio_user_id> <nuovo_user_id>");
const workDir = path.join("tmp", "face-copy");
await fsp.mkdir(workDir, { recursive: true });

const local = path.join(workDir, "old-index.json");
await storageProvider.downloadToFile(faceLibraryIndexKey(from), local);
const old = JSON.parse(await fsp.readFile(local, "utf8")) as FaceLibraryIndex;
const current = await readFaceLibrary(to, workDir);
const known = new Set(current.faces.map((f) => f.id));
const merged: FaceLibraryIndex = { faces: [...current.faces, ...old.faces.filter((f) => !known.has(f.id))] };

await fsp.writeFile(local, JSON.stringify(merged));
await storageProvider.uploadFile(local, faceLibraryIndexKey(to), "application/json");
await fsp.rm(workDir, { recursive: true, force: true });
const labeled = merged.faces.filter((f) => f.status === "labeled");
console.log(`Facce: ${old.faces.length} dal vecchio account, ${current.faces.length} già nel nuovo, ${merged.faces.length} in tutto`);
console.log(`Con nome: ${labeled.length} (${[...new Set(labeled.map((f) => f.label))].join(", ")})`);

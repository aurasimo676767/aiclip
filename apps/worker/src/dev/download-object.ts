import "dotenv/config";
import fs from "node:fs";
import { storageProvider } from "../lib/providers.js";

/** Scarica un oggetto dello storage (copertine, video) per guardarlo. Uso: tsx src/dev/download-object.ts <storagePath> <out> */
const [storagePath, out] = process.argv.slice(2);
const res = await fetch(await storageProvider.getSignedUrl(storagePath!, 300));
if (!res.ok) throw new Error(`Download fallito: ${res.status}`);
fs.writeFileSync(out!, Buffer.from(await res.arrayBuffer()));
console.log(`Scaricato ${storagePath} → ${out}`);

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { storageProvider } from "../lib/providers.js";

const storagePath = process.argv[2];
if (!storagePath) {
  console.error("Uso: tsx src/dev/test-resumable-download.ts <storage-path-r2>");
  process.exit(1);
}

const outDir = path.join(process.cwd(), "tmp", "resumable-test");
await fsp.mkdir(outDir, { recursive: true });

const fullPath = path.join(outDir, "full.bin");
const resumedPath = path.join(outDir, "resumed.bin");

console.log("1) Download normale (baseline)...");
await storageProvider.downloadToFile(storagePath, fullPath);
const fullSize = (await fsp.stat(fullPath)).size;
const fullHash = crypto.createHash("sha256").update(await fsp.readFile(fullPath)).digest("hex");
console.log(`   OK: ${fullSize} bytes, sha256 ${fullHash}`);

console.log("2) Simulo un download interrotto a metà (tronco il file) e ritento sullo stesso path...");
const half = Buffer.from((await fsp.readFile(fullPath)).subarray(0, Math.floor(fullSize / 2)));
await fsp.writeFile(resumedPath, half);
console.log(`   file troncato a ${half.length}/${fullSize} bytes, chiamo downloadToFile di nuovo sullo stesso file...`);
await storageProvider.downloadToFile(storagePath, resumedPath);
const resumedSize = (await fsp.stat(resumedPath)).size;
const resumedHash = crypto.createHash("sha256").update(await fsp.readFile(resumedPath)).digest("hex");
console.log(`   risultato: ${resumedSize} bytes, sha256 ${resumedHash}`);

console.log(fullHash === resumedHash && fullSize === resumedSize ? "OK: ripresa integra, hash identico" : "FALLITO: hash o size diversi!");

await fsp.rm(outDir, { recursive: true, force: true });

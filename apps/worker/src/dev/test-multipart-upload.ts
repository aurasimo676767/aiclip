import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { storageProvider } from "../lib/providers.js";

const localPath = process.argv[2];
if (!localPath) {
  console.error("Uso: tsx src/dev/test-multipart-upload.ts <path-file-locale>");
  process.exit(1);
}

const storagePath = `dev-tests/multipart-${Date.now()}.bin`;
const downloadedPath = `${localPath}.roundtrip`;

const originalHash = crypto.createHash("sha256").update(await fsp.readFile(localPath)).digest("hex");
console.log("Upload in corso...");
await storageProvider.uploadFile(localPath, storagePath, "application/octet-stream");
console.log("Upload completato, scarico per verificare...");
await storageProvider.downloadToFile(storagePath, downloadedPath);

const downloadedHash = crypto.createHash("sha256").update(await fsp.readFile(downloadedPath)).digest("hex");
console.log("hash originale:  ", originalHash);
console.log("hash scaricato:  ", downloadedHash);
console.log(originalHash === downloadedHash ? "OK: integrità confermata" : "FALLITO: hash diversi!");

await storageProvider.remove(storagePath);
await fsp.rm(downloadedPath, { force: true });

import { storageProvider } from "../lib/providers.js";

const storagePath = process.argv[2];
const localPath = process.argv[3];
if (!storagePath || !localPath) {
  console.error("Uso: tsx src/dev/test-already-complete-download.ts <storage-path> <local-path-gia-completo>");
  process.exit(1);
}

const t0 = Date.now();
await storageProvider.downloadToFile(storagePath, localPath);
console.log(`OK in ${((Date.now() - t0) / 1000).toFixed(2)}s — nessun errore, il file già completo è stato riconosciuto`);

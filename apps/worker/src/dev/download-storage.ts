import "dotenv/config";
import { storageProvider } from "../lib/providers.js";

/** Scarica un file dallo storage in locale. Uso: tsx src/dev/download-storage.ts <percorso storage> <file locale> */
const [key, out] = process.argv.slice(2);
await storageProvider.downloadToFile(key!, out!);
console.log("ok", out);

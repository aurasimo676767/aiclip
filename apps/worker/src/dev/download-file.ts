import "dotenv/config";
import { storageProvider } from "../lib/providers.js";

/** Scarica un file dallo storage. Uso: tsx src/dev/download-file.ts <percorso storage> <file locale> */
const [from, to] = process.argv.slice(2);
await storageProvider.downloadToFile(from!, to!);
console.log("ok");

import { storageProvider } from "../lib/providers.js";

const storagePathArg = process.argv[2];
const outPathArg = process.argv[3];
if (!storagePathArg || !outPathArg) throw new Error("Uso: tsx download-storage-file.ts <storage-path> <output-path>");
const storagePath: string = storagePathArg;
const outPath: string = outPathArg;

storageProvider
  .downloadToFile(storagePath, outPath)
  .then(() => console.log("OK:", outPath))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

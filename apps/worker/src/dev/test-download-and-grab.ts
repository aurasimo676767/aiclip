import { storageProvider } from "../lib/providers.js";
import { runFfmpeg } from "../lib/ffmpeg.js";

const [storagePath, localPath, t1, t2, out1, out2] = process.argv.slice(2, 8) as [string, string, string, string, string, string];

await storageProvider.downloadToFile(storagePath, localPath);
console.log("scaricato", localPath);
await runFfmpeg(["-y", "-ss", t1, "-i", localPath, "-frames:v", "1", out1]);
await runFfmpeg(["-y", "-ss", t2, "-i", localPath, "-frames:v", "1", out2]);
console.log("estratti", out1, out2);

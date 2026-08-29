import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { suspendHeavyProcesses, resumeHeavyProcesses } from "../lib/pause-control.js";

const ffmpeg = spawn("ffmpeg", ["-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30", "-t", "30", "-f", "null", "-"], {
  windowsHide: true,
});
console.log("ffmpeg avviato, pid", ffmpeg.pid);

await sleep(2000);

console.log("Sospendo...");
await suspendHeavyProcesses();
await sleep(4000);
console.log("Ripreso? aspettato 4s durante la sospensione, ora riprendo...");
await resumeHeavyProcesses();

await new Promise<void>((resolve) => {
  ffmpeg.on("exit", (code) => {
    console.log("ffmpeg terminato con codice", code);
    resolve();
  });
});

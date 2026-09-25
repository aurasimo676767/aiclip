import path from "node:path";
import fsp from "node:fs/promises";
import { probeVideo } from "../lib/ffmpeg.js";
import { ReactionCamFaceTracker } from "../face-tracking/reaction-cam-face-tracker.js";
import { planLongformEdit, renderEditedLongform } from "../render/longform-auto-edit.js";

/**
 * Prova il montaggio automatico long-form su un pezzo di un sorgente locale, gratis (nessuna AI).
 * Uso: tsx src/dev/test-longform-edit.ts <sorgente> <inizio s> <fine s> <out.mp4>
 */
const [source, startArg, endArg, outArg] = process.argv.slice(2);
if (!source || !startArg || !endArg || !outArg) throw new Error("Uso: tsx src/dev/test-longform-edit.ts <sorgente> <inizio> <fine> <out.mp4>");
const start = Number(startArg);
const end = Number(endArg);
const probe = await probeVideo(source);
const t0 = Date.now();
const plan = await planLongformEdit({ sourceVideoPath: source, sourceWidth: probe.width!, sourceHeight: probe.height!, start, end, faceTracker: new ReactionCamFaceTracker() });
const t1 = Date.now();
const workDir = path.join(path.dirname(path.resolve(outArg)), "edit-work");
await fsp.mkdir(workDir, { recursive: true });
await renderEditedLongform({ sourceVideoPath: source, start, end, plan, workDir, outputPath: path.resolve(outArg) });
const t2 = Date.now();
console.log(JSON.stringify({ analisiSec: Math.round((t1 - t0) / 1000), renderSec: Math.round((t2 - t1) / 1000), durataIn: end - start, durataOut: Math.round(plan.outputDuration), tagli: plan.keep.length - 1, stacchi: plan.punches.map((p) => `${p.start.toFixed(1)}@${p.cam.x},${p.cam.y}`) }));

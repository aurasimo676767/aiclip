import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { runFfmpeg, probeVideo } from "../lib/ffmpeg.js";
import { findSpeakingWebcam } from "../face-tracking/closeup-cams.js";
import { zoomWindow } from "../render/longform-auto-edit.js";
import { env } from "../env.js";

/**
 * Prova gratis dei primi piani dei video lunghi, come li fa il montaggio: per ogni istante le webcam
 * di quel momento e chi parla. A sinistra il fotogramma intero (verde = webcam scelta, giallo = zoom),
 * a destra il primo piano come uscirebbe. Uso: tsx src/dev/test-closeup-framing.ts <sorgente> <secondo:durata>...
 */
const [source, ...moments] = process.argv.slice(2);
const probe = await probeVideo(source!);
const W = probe.width!;
const H = probe.height!;
const dir = path.join(env.WORKER_TMP_DIR, "test-zoom");
await fsp.mkdir(dir, { recursive: true });
const font = "fontfile='C\\:/Windows/Fonts/arialbd.ttf'";
const rows: string[] = [];
for (const [i, m] of moments.entries()) {
  const [t, len] = m.split(":").map(Number) as [number, number];
  const found = await findSpeakingWebcam({ videoPath: source!, width: W, height: H, from: t - 1.5, to: t + len + 0.5, focusFrom: t, focusTo: t + len });
  const at = (t + len / 2).toFixed(2);
  const out = path.join(dir, `r${i}.png`);
  const s = 960 / W;
  const box = (c: { x: number; y: number; width: number; height: number }, color: string, th: number) =>
    `drawbox=x=${Math.round(c.x * s)}:y=${Math.round(c.y * s)}:w=${Math.round(c.width * s)}:h=${Math.round(c.height * s)}:color=${color}:t=${th}`;
  if (!found) {
    await runFfmpeg(["-y", "-ss", at, "-i", source!, "-frames:v", "1", "-vf", `scale=960:540,drawtext=${font}:text='${t} nessuno parla chiaramente':x=10:y=10:fontsize=28:fontcolor=red:box=1:boxcolor=black,pad=1920:540`, out]);
  } else {
    const z = zoomWindow(found.rect, W, H);
    await runFfmpeg([
      "-y", "-ss", at, "-i", source!, "-frames:v", "1", "-filter_complex",
      `[0:v]split[a][b];[a]scale=960:540,${box(found.rect, "lime", 3)},${box(z, "yellow", 2)},drawtext=${font}:text='${t}':x=10:y=10:fontsize=28:fontcolor=yellow:box=1:boxcolor=black[l];[b]crop=${z.width}:${z.height}:${z.x}:${z.y},scale=960:540:flags=lanczos,unsharp=5:5:0.9:5:5:0.0[r];[l][r]hstack`,
      out,
    ]);
  }
  rows.push(out);
}
const sheet = path.join(env.WORKER_TMP_DIR, "test-zoom.jpg");
await runFfmpeg(["-y", ...rows.flatMap((r) => ["-i", r]), "-filter_complex", `${rows.map((_, i) => `[${i}:v]`).join("")}vstack=inputs=${rows.length}`, "-q:v", "4", sheet]);
await fsp.rm(dir, { recursive: true, force: true });
console.log(sheet);

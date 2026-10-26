import fs from "node:fs";
import path from "node:path";
import { BUILTIN_CAPTION_PRESETS, type CaptionTrack } from "@clipforge/shared";
import { runFfmpeg } from "../lib/ffmpeg.js";
import { subtitlesFilter } from "../render/captions.js";
import { buildStyledAss } from "../render/styled-captions.js";

/**
 * Foglio di prova degli stili (gratis): per ogni preset brucia i sottotitoli sull'anteprima senza
 * sottotitoli di uno Short e ne prende qualche fotogramma, uno stile per riga.
 * Uso: tsx src/dev/caption-presets-sheet.ts <preview.mp4> <captions.json> <out.jpg> [t1,t2,...]
 */
const [preview, trackFile, out, timesArg = "2,4.2,6.6,9"] = process.argv.slice(2);
const track = JSON.parse(fs.readFileSync(trackFile!, "utf8")) as CaptionTrack;
const times = timesArg.split(",").map(Number);
const dir = path.join(path.dirname(path.resolve(out!)), "presets-work");
fs.mkdirSync(dir, { recursive: true });
const rows: string[] = [];
for (const preset of BUILTIN_CAPTION_PRESETS) {
  const ass = path.join(dir, `${preset.id}.ass`);
  fs.writeFileSync(ass, buildStyledAss(track, preset.settings));
  const frames: string[] = [];
  for (const t of times) {
    const f = path.join(dir, `${preset.id}-${t}.png`);
    // I sottotitoli si bruciano sull'intervallo vicino a t (le animazioni partono dall'inizio della parola).
    await runFfmpeg(["-y", "-i", preview!, "-vf", `${subtitlesFilter(ass)},trim=start=${t},setpts=PTS-STARTPTS,scale=270:480`, "-frames:v", "1", f]);
    frames.push(f);
  }
  const row = path.join(dir, `${preset.id}-row.png`);
  await runFfmpeg(["-y", ...frames.flatMap((f) => ["-i", f]), "-filter_complex", `hstack=inputs=${frames.length},drawtext=text='${preset.name}':x=8:y=8:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.7:fontfile='C\\:/Windows/Fonts/arialbd.ttf'`, row]);
  rows.push(row);
}
await runFfmpeg(["-y", ...rows.flatMap((r) => ["-i", r]), "-filter_complex", `vstack=inputs=${rows.length}`, path.resolve(out!)]);
console.log("ok", out);

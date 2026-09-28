import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { renderEditedLongform, type LongformEditPlan } from "../render/longform-auto-edit.js";

/**
 * Rifà il render di un montaggio da un piano salvato (quello di test-longform-edit.ts), senza AI:
 * per correggere a mano un video che piace già. `extend=<n>:<fine>` sposta la fine del tratto n
 * (secondi dal pezzo); gli stacchi si ricalcolano sul nuovo montaggio.
 * Uso: tsx src/dev/render-from-plan.ts <piano.json> <sorgente> <inizio> <fine> <out.mp4> [extend=n:fine]
 */
const [planFile, source, startArg, endArg, outArg, ...opts] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile!, "utf8")) as LongformEditPlan & { punches: Array<{ start: number; end: number; sourceStart: number }> };
for (const o of opts.filter((x) => x.startsWith("extend="))) {
  const [n, end] = o.slice(7).split(":").map(Number);
  plan.keep[n!]!.end = end!;
}
const toOutput = (t: number) => {
  let out = 0;
  for (const k of plan.keep) {
    if (t >= k.end) out += k.end - k.start;
    else if (t >= k.start) return out + (t - k.start);
  }
  return out;
};
for (const p of plan.punches) {
  const len = p.end - p.start;
  p.start = toOutput(p.sourceStart);
  p.end = p.start + len;
}
plan.outputDuration = plan.keep.reduce((sum, k) => sum + (k.end - k.start), 0);
const out = path.resolve(outArg!);
const workDir = path.join(path.dirname(out), "edit-work");
await fsp.mkdir(workDir, { recursive: true });
await fsp.writeFile(out + ".plan.json", JSON.stringify(plan, null, 1));
await renderEditedLongform({ sourceVideoPath: source!, start: Number(startArg), end: Number(endArg), plan, workDir, outputPath: out });
console.log(JSON.stringify({ durata: Math.round(plan.outputDuration + plan.intro.reduce((a, r) => a + (r.end - r.start), 0)), stacchi: plan.punches.map((p) => p.start.toFixed(1)) }));

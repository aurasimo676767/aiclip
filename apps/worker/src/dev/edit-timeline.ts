import "dotenv/config";
import fs from "node:fs";
import { supabase } from "../lib/supabase.js";

/**
 * Minutaggi di un video montato, per guardare solo i punti di montaggio: intro, tagli grossi
 * (con quanto è stato tolto) e stacchi sulla webcam, con la frase che si sente lì.
 * Uso: tsx src/dev/edit-timeline.ts <piano.json> <videoId> <inizio clip nel VOD>
 */
const [planFile, videoId, clipStartArg] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile!, "utf8")) as {
  keep: Array<{ start: number; end: number }>;
  intro: Array<{ start: number; end: number }>;
  punches: Array<{ start: number; end: number }>;
};
const clipStart = Number(clipStartArg);
const { data } = await supabase.from("transcripts").select("segments").eq("video_id", videoId!).single();
const segs = data!.segments as Array<{ start: number; end: number; text: string }>;
const say = (t: number) => {
  const s = segs.find((x) => x.start - clipStart <= t && x.end - clipStart > t);
  return s ? s.text.trim().slice(0, 90) : "";
};
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const introDur = plan.intro.reduce((a, r) => a + (r.end - r.start), 0);
console.log(`0:00 intro (${introDur.toFixed(1)} s), poi il video a ${mmss(introDur)}`);
let out = introDur;
for (const [i, k] of plan.keep.entries()) {
  if (i > 0) {
    const removed = k.start - plan.keep[i - 1]!.end;
    if (removed >= 20) console.log(`${mmss(out)} TAGLIO: tolti ${mmss(removed)} → riprende con: "${say(k.start + 1)}"`);
  }
  out += k.end - k.start;
}
for (const p of plan.punches) console.log(`${mmss(introDur + p.start)} stacco sulla webcam (urlo)`);
console.log(`fine ${mmss(out)}`);

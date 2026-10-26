import "dotenv/config";
import fs from "node:fs";
import { detectMatchPhases, matchesFrom, type PhaseSegment } from "../providers/ai/match-phases.js";
import { detectGameTimeline, type GameSegment } from "../providers/ai/game-timeline.js";
import { supabase } from "../lib/supabase.js";
import { env } from "../env.js";

/**
 * Prova del modello economico sui compiti di vista semplici (simo, 2026-10-26, punto 5 dei costi):
 * stessa clip, mappa delle fasi e mappa dei giochi rifatte col modello CHEAP e confrontate con quelle
 * del modello forte già salvate. Lanciare con WORKER_TMP_DIR diverso, così la cache delle fasi non
 * restituisce quelle del modello forte.
 * Uso: WORKER_TMP_DIR=tmp/prova-luna tsx src/dev/compare-cheap-vision.ts <clipId> <sorgente> <fasi forte.json>
 */
const [clipId, source, strongPhasesFile] = process.argv.slice(2) as [string, string, string];
const { data: clip } = await supabase.from("clips").select("start_time, end_time, longform_games").eq("id", clipId).single();
const strongGames = clip!.longform_games as GameSegment[];
const strongPhases = JSON.parse(fs.readFileSync(strongPhasesFile, "utf8")) as PhaseSegment[];
const cheap = env.ANTHROPIC_MODEL_CHEAP;
const opts = { apiKey: env.ANTHROPIC_API_KEY, model: cheap };

// 1. Mappa dei giochi
const games = await detectGameTimeline({ sourceVideoPath: source, start: clip!.start_time, end: clip!.end_time }, opts);
const fmt = (s: GameSegment) => `${(s.start / 60).toFixed(1)}-${(s.end / 60).toFixed(1)} ${s.kind} ${s.name}`;
console.log(`\nMAPPA DEI GIOCHI\nforte (${strongGames.length}): ${strongGames.map(fmt).join(" | ")}\n${cheap} (${games?.length ?? 0}): ${(games ?? []).map(fmt).join(" | ")}`);

// 2. Fasi, sugli stessi tratti
const ranges = [{ start: Math.min(...strongPhases.map((p) => p.start)) + 5 - 5, end: Math.max(...strongPhases.map((p) => p.end)) }];
const allowed = strongPhases.reduce<Array<{ start: number; end: number }>>((out, p) => {
  const last = out[out.length - 1];
  if (last && p.start - last.end < 1) last.end = p.end;
  else out.push({ start: p.start, end: p.end });
  return out;
}, []);
const phases = await detectMatchPhases({ sourceVideoPath: source, start: clip!.start_time, end: clip!.end_time, ranges: allowed.length ? allowed : ranges }, opts);
if (!phases) throw new Error("fasi economiche fallite");
const at = (ps: PhaseSegment[], t: number) => ps.find((p) => t >= p.start && t < p.end);
let same = 0;
let samePlay = 0;
let n = 0;
const play = (p?: PhaseSegment) => (p ? (p.phase === "partita" || p.phase === "inizio" || p.phase === "fine" ? "gioco" : "fermo") : "?");
const confusion = new Map<string, number>();
for (const p of strongPhases) {
  for (let t = p.start + 5; t < p.end; t += 10) {
    const c = at(phases, t);
    n++;
    if (c?.phase === p.phase) same++;
    if (play(c) === play(p)) samePlay++;
    if (c?.phase !== p.phase) confusion.set(`${p.phase}→${c?.phase}`, (confusion.get(`${p.phase}→${c?.phase}`) ?? 0) + 1);
  }
}
const sm = matchesFrom(strongPhases);
const cm = matchesFrom(phases);
console.log(`\nFASI su ${n} fotogrammi: stessa fase ${((100 * same) / n).toFixed(0)}%, stesso "si gioca / fermo" ${((100 * samePlay) / n).toFixed(0)}%`);
console.log(`differenze più frequenti: ${[...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`partite: forte ${sm.length}, ${cheap} ${cm.length}`);
const nearest = (m: { start: number; end: number }) => cm.reduce((best, x) => (Math.abs(x.start - m.start) < Math.abs(best.start - m.start) ? x : best), cm[0]!);
const startErr = sm.map((m) => Math.abs(nearest(m).start - m.start)).sort((a, b) => a - b);
const endErr = sm.map((m) => Math.abs(nearest(m).end - m.end)).sort((a, b) => a - b);
console.log(`scarto inizio partite (mediana/peggiore): ${startErr[Math.floor(startErr.length / 2)]?.toFixed(0)} / ${startErr.at(-1)?.toFixed(0)} s; fine: ${endErr[Math.floor(endErr.length / 2)]?.toFixed(0)} / ${endErr.at(-1)?.toFixed(0)} s`);

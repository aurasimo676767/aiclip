import { measureRmsWindows, WINDOW_SECONDS } from "../render/word-loudness.js";

/** Profilo del volume di un tratto: percentili e quanti tratti "morti"/"urlati" a varie soglie. Uso: tsx src/dev/audio-profile.ts <sorgente> <inizio> <fine> */
const [src, s, e] = process.argv.slice(2);
const levels = await measureRmsWindows(src!, Number(s), Number(e) - Number(s));
const per = Math.round(0.5 / WINDOW_SECONDS);
const bins: number[] = [];
for (let i = 0; i < levels.length; i += per) {
  const sl = levels.slice(i, i + per);
  const p = sl.reduce((a, db) => a + 10 ** (db / 10), 0) / sl.length;
  bins.push(p > 0 ? 10 * Math.log10(p) : -100);
}
const sorted = [...bins].sort((a, b) => a - b);
const pct = (q: number) => sorted[Math.floor(q * (sorted.length - 1))]!.toFixed(1);
const med = sorted[Math.floor(sorted.length / 2)]!;
console.log(`p5 ${pct(0.05)}  p25 ${pct(0.25)}  mediana ${med.toFixed(1)}  p75 ${pct(0.75)}  p95 ${pct(0.95)}  p99 ${pct(0.99)}`);
const runs = (test: (d: number) => boolean, minBins: number) => {
  let n = 0, len = 0, tot = 0;
  for (const d of [...bins, Infinity]) {
    if (d !== Infinity && test(d)) len++;
    else { if (len >= minBins) { n++; tot += len * 0.5; } len = 0; }
  }
  return `${n} tratti, ${tot}s`;
};
for (const below of [8, 10, 12, 14]) console.log(`sotto -${below}dB per >=2s: ${runs((d) => d < med - below, 4)} | >=3s: ${runs((d) => d < med - below, 6)}`);
for (const above of [6, 8, 9, 10, 12]) console.log(`sopra +${above}dB per >=1s: ${runs((d) => d >= med + above, 2)}`);

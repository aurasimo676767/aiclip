import "dotenv/config";
import { supabase } from "../lib/supabase.js";

/**
 * Misura come partono gli Shorts (richiesta di simo, 2026-09-26: "partono troppo presto o troppo
 * tardi"). Per ogni Short renderizzato guarda i tempi PER PAROLA del transcript e dice:
 * - quanto margine c'è prima della prima parola (negativo = parte a metà parola);
 * - dove cade la frase-gancio scelta dall'AI rispetto all'inizio (positivo = parte prima);
 * - cosa si sente nei primi 2,5 secondi.
 * Gratis, solo lettura. Uso: tsx src/dev/measure-short-starts.ts [quanti=25]
 */
interface Word {
  word: string;
  start: number;
  end: number;
}
const limit = Number(process.argv[2] ?? 25);
const { data: clips } = await supabase
  .from("clips")
  .select("id, video_id, title, hook, start_time, end_time")
  .eq("format", "short")
  .eq("status", "COMPLETED")
  .order("created_at", { ascending: false })
  .limit(limit);

const transcripts = new Map<string, Word[]>();
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
let n = 0;
const stats = { tagliaParola: 0, gancioDopo: [] as number[], margine: [] as number[] };
for (const c of clips ?? []) {
  if (!transcripts.has(c.video_id)) {
    const { data } = await supabase.from("transcripts").select("segments").eq("video_id", c.video_id).maybeSingle();
    const segs = (data?.segments ?? []) as Array<{ words?: Word[] }>;
    transcripts.set(c.video_id, segs.flatMap((s) => s.words ?? []).sort((a, b) => a.start - b.start));
  }
  const words = transcripts.get(c.video_id)!;
  if (words.length === 0) continue;
  n++;
  const start = c.start_time;
  const cut = words.find((w) => w.start < start && w.end > start + 0.05);
  const first = words.find((w) => w.start >= start - 0.05);
  const lead = first ? first.start - start : NaN;
  // Dove comincia la frase-gancio: le prime 3 parole del campo hook cercate fra -10 s e +15 s.
  const hookWords = (c.hook ?? "").split(/\s+/).map(norm).filter(Boolean).slice(0, 3);
  let hookAt: number | null = null;
  for (let i = 0; i < words.length && hookWords.length > 0; i++) {
    const w = words[i]!;
    if (w.start < start - 10 || w.start > start + 15) continue;
    if (hookWords.every((h, k) => norm(words[i + k]?.word ?? "") === h)) {
      hookAt = w.start;
      break;
    }
  }
  const first25 = words.filter((w) => w.start >= start - 0.05 && w.start < start + 2.5).map((w) => w.word).join(" ");
  if (cut) stats.tagliaParola++;
  if (!Number.isNaN(lead)) stats.margine.push(lead);
  if (hookAt !== null) stats.gancioDopo.push(hookAt - start);
  console.log(
    [
      `${n}. ${c.title}`,
      `   margine prima della 1a parola: ${Number.isNaN(lead) ? "?" : lead.toFixed(2) + " s"}${cut ? ` (PARTE A META' DI "${cut.word}")` : ""}`,
      `   gancio dell'AI: ${hookAt === null ? "non trovato nel parlato" : `${(hookAt - start).toFixed(1)} s dopo l'inizio`} — "${(c.hook ?? "").slice(0, 70)}"`,
      `   primi 2,5 s: "${first25}"`,
    ].join("\n"),
  );
}
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!.toFixed(2) : "?");
console.log(
  `\nRIASSUNTO su ${n} Shorts: partono a metà parola ${stats.tagliaParola}; margine mediano prima della 1a parola ${med(stats.margine)} s; ` +
    `gancio trovato in ${stats.gancioDopo.length}, mediana ${med(stats.gancioDopo)} s dopo l'inizio, oltre 2 s in ${stats.gancioDopo.filter((x) => x > 2).length}.`,
);

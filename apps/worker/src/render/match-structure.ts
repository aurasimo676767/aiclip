import type { TranscriptSegment } from "@clipforge/shared";
import { matchesFrom, type PhaseSegment } from "../providers/ai/match-phases.js";

/**
 * Regole di simo sul montato (2026-10-26), garantite dal codice e non solo chieste all'AI: "si deve
 * vedere loro che giocano", menu e attese brevi, una breve presentazione e poi il gioco parte quasi
 * subito, e di ogni partita tenuta si vede come comincia e come finisce ("anche se magari nel mezzo si
 * taglia"), per ogni gioco. Parte dai tratti scelti dall'AI e li ritocca con le fasi viste a schermo
 * (match-phases.ts). Tutti i tempi sono in secondi dall'inizio del pezzo.
 */

export interface Range {
  start: number;
  end: number;
}

/** Di una partita tenuta: i primi secondi (schermata d'inizio, "Via!") e gli ultimi (ultimo punto, risultato). */
const MATCH_START_SECONDS = 15;
const MATCH_END_SECONDS = 20;
/** Menu, caricamenti e attese di fila nel video montato: al massimo così, presi a ridosso della partita dopo. */
const MENU_MAX_SECONDS = 15;
/** Prima della prima partita: la presentazione ("dai andiamo a giocare a..."), al massimo così. */
const SETUP_MAX_SECONDS = 35;
/** Attorno a un momento forte (intro, primo piano) dentro un menu: lì il menu resta. */
const STRONG_PAD_SECONDS = 3;
/** Pezzi più vicini di così si uniscono; più corti di così si buttano. */
const MERGE_GAP_SECONDS = 4;
const MIN_PIECE_SECONDS = 3;

const total = (rs: Range[]) => rs.reduce((sum, r) => sum + (r.end - r.start), 0);

function normalize(ranges: Range[], duration: number): Range[] {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start - last.end < MERGE_GAP_SECONDS) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out.filter((r) => r.end - r.start >= MIN_PIECE_SECONDS);
}

function intersect(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  for (const x of a) for (const y of b) {
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end });
  }
  return out.sort((p, q) => p.start - q.start);
}

function subtract(a: Range[], b: Range[]): Range[] {
  let out = a.map((r) => ({ ...r }));
  for (const y of b) {
    out = out.flatMap((x) => {
      if (y.end <= x.start || y.start >= x.end) return [x];
      const parts: Range[] = [];
      if (y.start > x.start) parts.push({ start: x.start, end: y.start });
      if (y.end < x.end) parts.push({ start: y.end, end: x.end });
      return parts;
    });
  }
  return out;
}

/** Il punto sposta all'inizio della frase che lo contiene (i tagli non devono cadere a metà parola). */
function sentenceStart(t: number, segments: TranscriptSegment[]): number {
  const s = segments.find((seg) => t > seg.start && t < seg.end);
  return s && t - s.start <= 6 ? s.start : t;
}

export function enforceMatchStructure(params: {
  keep: Range[];
  phases: PhaseSegment[];
  segments: TranscriptSegment[];
  duration: number;
  /** Momenti forti scelti dall'AI (intro, primi piani): dentro un menu restano. */
  strong: Range[];
}): { keep: Range[]; note: string } {
  const { phases, segments, duration } = params;
  const matches = matchesFrom(phases);
  let keep = normalize(params.keep, duration);
  const before = total(keep);

  // 1. Di ogni partita tenuta (anche solo in parte) si vedono inizio e fine.
  const kept = matches.filter((m) => total(intersect(keep, [m])) >= 8);
  const edges = (m: { start: number; end: number }): Range[] => [
    { start: sentenceStart(m.start - 3, segments), end: Math.min(m.end, m.start + MATCH_START_SECONDS) },
    { start: sentenceStart(Math.max(m.start, m.end - MATCH_END_SECONDS), segments), end: m.end + 4 },
  ];
  const added: Range[] = kept.flatMap(edges);
  // 2. Ogni gioco ha almeno una partita: se l'AI ne ha tolto uno del tutto, la sua partita più lunga.
  const keptGames = new Set(kept.map((m) => m.game));
  for (const game of new Set(matches.map((m) => m.game))) {
    if (keptGames.has(game)) continue;
    const longest = matches.filter((m) => m.game === game).sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    if (longest) added.push(...edges(longest));
  }
  keep = normalize([...keep, ...added], duration);

  // 3. Menu, caricamenti e "altro" brevi: di ogni tratto di fila resta la coda (il passaggio alla
  // partita), più i momenti forti che ci cadono dentro. Prima della prima partita c'è più spazio:
  // è la presentazione del video.
  const idle = normalize(phases.filter((p) => p.phase === "menu" || p.phase === "caricamento" || p.phase === "altro"), duration);
  const firstMatch = matches.find((m) => total(intersect(keep, [m])) > 0)?.start ?? Infinity;
  const strong = params.strong.map((r) => ({ start: r.start - STRONG_PAD_SECONDS, end: r.end + STRONG_PAD_SECONDS }));
  const drop: Range[] = [];
  for (const run of normalize(intersect(keep, idle), duration)) {
    const max = run.end <= firstMatch + 1 ? SETUP_MAX_SECONDS : MENU_MAX_SECONDS;
    if (run.end - run.start <= max) continue;
    const tailStart = sentenceStart(run.end - max, segments);
    drop.push(...subtract([{ start: run.start, end: tailStart }], intersect([{ start: run.start, end: tailStart }], strong)));
  }
  keep = normalize(subtract(keep, drop), duration);

  const note = `partite ${matches.length} (tenute ${kept.length}), giochi ${keptGames.size}/${new Set(matches.map((m) => m.game)).size}, +${Math.round(total(added))} s inizi/fini, -${Math.round(total(drop))} s di menu, da ${Math.round(before / 60)} a ${Math.round(total(keep) / 60)} min`;
  return { keep, note };
}

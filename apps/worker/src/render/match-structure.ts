import type { TranscriptSegment } from "@clipforge/shared";
import { matchesFrom, type Match, type PhaseSegment } from "../providers/ai/match-phases.js";

/**
 * Regole di simo sul montato (2026-10-26), garantite dal codice e non solo chieste all'AI: "si deve
 * vedere loro che giocano", menu e attese brevi, una breve presentazione e poi il gioco parte quasi
 * subito, e di ogni partita tenuta si vede come comincia e come finisce ("anche se magari nel mezzo si
 * taglia"), per ogni gioco. Parte dai tratti scelti dall'AI e li ritocca con le fasi viste a schermo
 * (match-phases.ts). Vale per qualunque gioco con partite o round; il chiamante non la usa nelle
 * reaction e dove si gioca poco. Tutti i tempi sono in secondi dall'inizio del pezzo.
 *
 * Prima prova (Switch Sports di Blur, 2026-10-26): inizio e fine aggiunti a ogni partita di cui l'AI
 * teneva anche solo 8 s portavano il video da 42 a 48 minuti, e prima del primo "Via!" c'era più di un
 * minuto di menu e tutorial (il tetto valeva pezzo per pezzo, non in tutto).
 */

export interface Range {
  start: number;
  end: number;
}

/** Di una partita tenuta: i primi secondi (schermata d'inizio, "Via!") e gli ultimi (ultimo punto, risultato). */
const MATCH_START_SECONDS = 12;
const MATCH_END_SECONDS = 15;
/** Una partita conta come tenuta (e prende inizio e fine) se l'AI ne ha tenuto almeno così; i pezzetti sotto si tolgono, salvo un momento forte. */
const MIN_KEPT_FOR_EDGES = 30;
/** Un gioco conta (e deve avere almeno una partita) se a schermo si gioca almeno così: sotto è un fotogramma riconosciuto male. */
const MIN_GAME_SECONDS = 60;
/** Menu, caricamenti e attese di fila nel video montato: al massimo così, presi a ridosso della partita dopo. */
const MENU_MAX_SECONDS = 15;
/** Prima della prima partita, IN TUTTO: la presentazione ("dai andiamo a giocare a..."), poi si gioca. */
const SETUP_MAX_SECONDS = 30;
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
  /** Momenti forti scelti dall'AI (intro, primi piani): restano anche dentro un menu o un pezzetto di partita. */
  strong: Range[];
}): { keep: Range[]; note: string } {
  const { phases, segments, duration } = params;
  const matches = matchesFrom(phases);
  const strong = params.strong.map((r) => ({ start: r.start - STRONG_PAD_SECONDS, end: r.end + STRONG_PAD_SECONDS }));
  let keep = normalize(params.keep, duration);
  const before = total(keep);

  // 1. Partite: tenuta = almeno MIN_KEPT_FOR_EDGES secondi, o un momento forte dentro. Delle tenute si
  // vedono inizio e fine; delle altre si tolgono i pezzetti rimasti (senza inizio né fine non si capiscono).
  const keptOf = (m: Match) => total(intersect(keep, [m]));
  const isKept = (m: Match) => keptOf(m) >= MIN_KEPT_FOR_EDGES || (keptOf(m) > 0 && intersect(strong, [m]).length > 0);
  const kept = matches.filter(isKept);
  const scraps = matches.filter((m) => !isKept(m) && keptOf(m) > 0);
  keep = normalize(subtract(keep, scraps), duration);
  const edges = (m: Match): Range[] => [
    { start: sentenceStart(m.start - 3, segments), end: Math.min(m.end, m.start + MATCH_START_SECONDS) },
    { start: sentenceStart(Math.max(m.start, m.end - MATCH_END_SECONDS), segments), end: m.end + 3 },
  ];
  const added: Range[] = kept.flatMap(edges);
  // 2. Ogni gioco vero ha almeno una partita: se l'AI ne ha tolto uno del tutto, la sua partita più lunga.
  const played = new Map<string, number>();
  for (const p of phases) if (p.phase === "partita" && p.game) played.set(p.game, (played.get(p.game) ?? 0) + (p.end - p.start));
  const games = [...played.entries()].filter(([, s]) => s >= MIN_GAME_SECONDS).map(([g]) => g);
  const keptGames = new Set(kept.map((m) => m.game));
  for (const game of games) {
    if (keptGames.has(game)) continue;
    const longest = matches.filter((m) => m.game === game).sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    if (longest) {
      added.push(...edges(longest));
      kept.push(longest);
    }
  }
  keep = normalize([...keep, ...added], duration);

  // 3. Menu, caricamenti e "altro" brevi: di ogni tratto di fila resta la coda (il passaggio alla
  // partita), più i momenti forti che ci cadono dentro.
  const idle = normalize(phases.filter((p) => p.phase === "menu" || p.phase === "caricamento" || p.phase === "altro"), duration);
  const firstMatch = Math.min(...kept.map((m) => m.start), Infinity);
  const drop: Range[] = [];
  for (const run of normalize(intersect(keep, idle), duration)) {
    if (run.end <= firstMatch + 1 || run.end - run.start <= MENU_MAX_SECONDS) continue;
    const tailStart = sentenceStart(run.end - MENU_MAX_SECONDS, segments);
    const head = [{ start: run.start, end: tailStart }];
    drop.push(...subtract(head, intersect(head, strong)));
  }
  // 4. Prima della prima partita, in tutto al massimo SETUP_MAX_SECONDS: si tiene la parte più vicina
  // alla partita (la scelta del gioco, "dai andiamo"), il resto va. I momenti forti dell'intro sono a parte.
  if (Number.isFinite(firstMatch)) {
    let budget = SETUP_MAX_SECONDS;
    for (const r of [...intersect(keep, [{ start: 0, end: firstMatch }])].reverse()) {
      const len = r.end - r.start;
      if (len <= budget) {
        budget -= len;
        continue;
      }
      const from = budget > 0 ? sentenceStart(r.end - budget, segments) : r.end;
      drop.push({ start: r.start, end: from });
      budget = 0;
    }
  }
  keep = normalize(subtract(keep, drop), duration);

  const note = `partite ${matches.length} (tenute ${kept.length}, pezzetti tolti ${scraps.length}), giochi ${keptGames.size}/${games.length}, +${Math.round(total(added))} s inizi/fini, -${Math.round(total(drop))} s di menu e attese, da ${Math.round(before / 60)} a ${Math.round(total(keep) / 60)} min`;
  return { keep, note };
}

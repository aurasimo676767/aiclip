/**
 * Censura automatica delle parole che YouTube e TikTok penalizzano (insulti sul corpo, offese,
 * volgarità forti, bestemmie) in titoli, scritte e sottotitoli: una lettera diventa un numero o un
 * asterisco, come fanno i creator ("cicci0ni"). Chiesto da simo il 2026-09-29 dopo Shorts con
 * "CICCIONI" nel titolo e nella scritta.
 *
 * Si cambia UNA lettera in mezzo alla parola, così resta leggibile. Maiuscole/minuscole rispettate.
 */

// Radici (senza accenti, minuscole). Un match vale per la parola intera che INIZIA con la radice.
const ROOTS = [
  // corpo
  "ciccion", "obes", "grassone", "grassona", "grassoni", "grassissim", "balena", "chiatt",
  // offese e disabilità
  "ritardat", "mongoloid", "mongolo", "handicappat", "spastic",
  // omofobia, razzismo
  "froci", "frocio", "finocch", "ricchion", "negr", "zingar",
  // volgarità forti
  "troia", "troie", "puttan", "zoccol", "cazz", "merd", "coglion", "stronz", "vaffancul", "fancul", "figa", "fighe", "minchi",
  // bestemmie (la parola "dio"/"madonna" si censura solo accanto a un insulto, vedi sotto)
  "porcodio", "diocane", "dioporco", "porcamadonna", "madonnaputtana",
] as const;

// Radici che valgono solo come parola intera (nessuna per ora); SKIP_PREFIXES evita "negroni" e simili.
const EXACT_ONLY = new Set<string>();
const SKIP_PREFIXES = ["download", "downtown", "negroni", "cazzuol"];

const LEET: Record<string, string> = { o: "0", i: "1", a: "4", e: "3", u: "*" };

function normalize(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** Una lettera in mezzo diventa numero/asterisco: la vocale più centrale, meglio una "o" ("cicci0ni", come simo). */
function mask(word: string): string {
  const letters = [...word];
  const mid = (letters.length - 1) / 2;
  const vowels = letters
    .map((c, i) => ({ c: c.toLowerCase(), i }))
    .filter((x) => x.i > 0 && LEET[x.c])
    .sort((x, y) => Number(y.c === "o") - Number(x.c === "o") || Math.abs(x.i - mid) - Math.abs(y.i - mid));
  const pick = vowels[0];
  if (pick) letters[pick.i] = LEET[pick.c]!;
  else letters[Math.min(1, letters.length - 1)] = "*";
  return letters.join("");
}

function isBad(word: string): boolean {
  const n = normalize(word).replace(/[^a-z]/g, "");
  if (n.length < 3 || SKIP_PREFIXES.some((p) => n.startsWith(p))) return false;
  return ROOTS.some((r) => (EXACT_ONLY.has(r) ? n === r : n.startsWith(r)));
}

const BLASPHEMY_PAIRS: Array<[RegExp, string]> = [
  [/\b(porc[oa])(\s+)(dio|madonna|cristo)\b/giu, "$1$2"],
  [/\b(dio|madonna|cristo)(\s+)(can[e]?|porc[oa]|maial[e]?|bestia|ladro|merda|boia|infame|serpente)\b/giu, "$1$2"],
];

/** Titolo/testo con le parole offensive censurate. */
export function censorText(text: string): string {
  let out = text.replace(/\p{L}[\p{L}'’]*/gu, (w) => (isBad(w) ? mask(w) : w));
  // Bestemmie di due parole: si censura la parola "sacra" (d1o, m4donna), non l'aggettivo.
  for (const [re] of BLASPHEMY_PAIRS) {
    out = out.replace(re, (m) => m.replace(/\b(dio|madonna|cristo)\b/giu, (w) => mask(w)));
  }
  return out;
}

/** Una singola parola (sottotitoli parola per parola). */
export function censorWord(word: string): string {
  return isBad(word) ? word.replace(/\p{L}[\p{L}'’]*/gu, (w) => (isBad(w) ? mask(w) : w)) : word;
}

/**
 * Parole che, nel titolo o nella descrizione di uno Short, fanno sì che YouTube non lo mostri
 * quasi a nessuno. Misurato sugli Shorts del canale il 2026-09-30: di norma uno Short fa
 * 1.000-1.300 views dal feed, questi invece 2-150 ("C3SSO"/"c0lo" 6, "SC0P4ARE il C2L0" 2,
 * "B***HINO" 19, "Che cazzo è..." 3, "Chi cazzo..." 5, "tette grosse" 25, "si sale da dietro" 9,
 * "PORCO DI" 148). Scriverle con numeri o asterischi NON basta: YouTube le riconosce lo stesso.
 *
 * feedRisk restituisce le parole a rischio trovate (vuoto = testo pulito), per avvisare prima di
 * pubblicare. Non cambia il testo.
 */

// Radici, dopo aver tolto accenti e rimesso le lettere al posto di numeri/simboli ("c0lo" → "colo").
const RISK_ROOTS = [
  // volgarità
  "cazz", "minchi", "merd", "puttan", "troia", "troie", "zoccol", "stronz", "coglion", "vaffancul", "fancul", "figa", "fighe",
  // sesso
  "scop", "pompin", "bocchin", "tett", "sesso", "sessual", "porno", "nud", "culo", "culi", "chiav", "sborr", "masturb", "orgasm", "cesso",
  // bestemmie
  "porcodio", "diocane", "dioporco", "porcamadonna",
  // temi che YouTube limita
  "stupr", "suicid", "pedofil", "cancro",
] as const;

// Parole normali che iniziano come una radice a rischio.
const SAFE_WORDS = [
  "scopo", "scopi", "scopr", "scope", "scoppi", "tetto", "tetti", "nudge", "culin", "culmin", "cult", "cultur",
  "chiave", "chiavi", "chiavett", "figata", "merdeka", "cazzuol",
];

const UNLEET: Record<string, string> = { "0": "o", "1": "i", "2": "u", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

function normalize(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[0-9@$]/g, (c) => UNLEET[c] ?? c)
    .replace(/[^a-z*]/g, "");
}

const BLASPHEMY = /\b(porc[oa]\s+(di[o0]?|madonna|cristo)|di[o0]\s+(can[e3]?|porc[oa]|maial[e3]?|bestia|ladro|merda|boia|infame))\b/giu;

/** Parole a rischio nel testo, come compaiono nel testo (senza doppioni). */
export function feedRisk(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(BLASPHEMY)) found.add(m[0]);
  for (const raw of text.split(/[\s.,;:!?"'“”«»()\[\]…\-–—/]+/)) {
    if (!raw) continue;
    const n = normalize(raw);
    // "B***HINO": una parola coperta da asterischi è quasi sempre una parolaccia.
    if (/[a-z]\*+[a-z]/.test(n)) {
      found.add(raw);
      continue;
    }
    const letters = n.replace(/\*/g, "");
    if (letters.length < 3 || SAFE_WORDS.some((s) => letters.startsWith(s))) continue;
    if (RISK_ROOTS.some((r) => letters.startsWith(r))) found.add(raw);
  }
  return [...found];
}

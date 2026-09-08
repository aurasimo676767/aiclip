const KEYWORD_SUFFIXES = ["reaction", "reazioni", "gameplay", "live", "twitch"];

/**
 * Parole chiave SEO per la descrizione: permutazioni "nome streamer" + una parola di genere
 * (reaction, gameplay, ...), nell'ordine e nello stile chiesti esplicitamente ("blur reaction,
 * reaction blur, blur reazioni..."). Deterministico, nessuna chiamata IA.
 */
function buildKeywordTags(streamerName: string): string {
  const name = streamerName.trim().toLowerCase();
  if (!name) return "";
  const tags = [`${name} reaction`, `reaction ${name}`, ...KEYWORD_SUFFIXES.slice(1).map((word) => `${name} ${word}`)];
  return tags.join(", ");
}

/**
 * Descrizione fissa per i video long-form pubblicati in automatico (Impostazioni → Programmazione
 * → orari fissi) — sostituisce la sola caption AI usata prima. `{streamer_name}`/`{streamer_login}`
 * vengono presi dal video sorgente, `{tag_keywords}` è generato qui sotto.
 */
export function buildLongformDescription(streamerName: string, streamerLogin: string | null): string {
  const login = streamerLogin ?? streamerName.toLowerCase();
  return `Clip presa da una diretta Twitch di ${streamerName} 🎮
Guarda le sue live complete su: twitch.tv/${login}

Iscriviti al canale per non perderti le prossime clip!

${buildKeywordTags(streamerName)}`;
}

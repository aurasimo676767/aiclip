/**
 * Hashtag fissi degli Shorts, uguali su YouTube e TikTok (simo, 2026-09-29: "gli hashtag nelle
 * descrizioni siano SEMPRE #blur #marza #pesh #manuxo #twitch #live #perte #foryou").
 */
export const SHORTS_HASHTAGS = ["#blur", "#marza", "#pesh", "#manuxo", "#twitch", "#live", "#perte", "#foryou"] as const;

/** Il testo senza gli hashtag che aveva, con in fondo quelli fissi. */
export function withShortsHashtags(text: string): string {
  const body = text
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*\n\s*/g, "\n\n")
    .trim();
  return body ? `${body}\n\n${SHORTS_HASHTAGS.join(" ")}` : SHORTS_HASHTAGS.join(" ");
}

/**
 * Per i video lunghi (simo, 2026-10-01: "tutti vai" alla proposta degli hashtag fissi anche lì): il
 * testo resta com'è (crediti allo streamer, link) e in fondo si aggiungono gli hashtag fissi che
 * mancano. Non toglie niente, a differenza di withShortsHashtags.
 */
export function withFixedHashtagsAppended(text: string): string {
  const lower = text.toLowerCase();
  const missing = SHORTS_HASHTAGS.filter((h) => !new RegExp(`${h}(?![\\p{L}\\p{N}_])`, "u").test(lower));
  if (missing.length === 0) return text;
  return text.trim() ? `${text.trimEnd()}\n\n${missing.join(" ")}` : missing.join(" ");
}

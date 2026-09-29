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

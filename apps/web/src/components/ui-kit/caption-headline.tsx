import type { CSSProperties } from "react";

/**
 * Titolo scritto come un sottotitolo degli Shorts che ClipForge produce: le parole entrano una alla
 * volta "a schiaffo", inclinate a turno, e ognuna si accende di giallo mentre viene "detta", poi
 * torna bianca. Succede una volta sola al caricamento; con "riduci animazioni" le parole compaiono
 * già ferme (vedi globals.css).
 */
export function CaptionHeadline({
  text,
  as: Tag = "h1",
  stepMs = 230,
  startMs = 150,
  className = "",
}: {
  text: string;
  as?: "h1" | "h2" | "p";
  stepMs?: number;
  startMs?: number;
  className?: string;
}) {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <Tag className={`type-caption ${className}`} aria-label={text}>
      {words.map((word, i) => (
        <span
          key={i}
          aria-hidden
          className="caption-word"
          style={
            {
              animationDelay: `${startMs + i * stepMs}ms`,
              "--tilt": i % 2 === 0 ? "-5deg" : "4deg",
              "--spoken": `${Math.round(stepMs * 1.8)}ms`,
            } as CSSProperties
          }
        >
          {word}
        </span>
      ))}
    </Tag>
  );
}

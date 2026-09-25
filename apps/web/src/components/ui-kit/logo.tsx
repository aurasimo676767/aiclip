import Link from "next/link";

/** Marchio: il "play" nero su un tassello giallo sottotitolo, col bordo nero sotto come le scritte degli Shorts. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[28%] bg-brand-400 shadow-slab"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none">
        <path d="M7 4.5v15l12.5-7.5L7 4.5z" fill="#000" />
      </svg>
    </span>
  );
}

export function Logo({ href = "/dashboard", iconOnly = false }: { href?: string; iconOnly?: boolean }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70">
      <LogoMark />
      {!iconOnly && (
        <span className="text-lg font-extrabold tracking-tight text-ink" style={{ fontStretch: "118%" }}>
          ClipForge
        </span>
      )}
    </Link>
  );
}

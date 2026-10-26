import Link from "next/link";

/** Marchio: un fotogramma verticale (9:16) con il "play", sull'accento azzurro. */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[30%] bg-gradient-to-b from-brand-400 to-brand-600"
      style={{ width: size, height: size, boxShadow: "0 1px 0 0 rgba(255,255,255,0.25) inset, 0 6px 14px -6px rgba(53,112,242,0.8)" }}
      aria-hidden
    >
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none">
        <rect x="6" y="2.5" width="12" height="19" rx="3" stroke="#fff" strokeWidth="1.8" />
        <path d="M10.5 9.2v5.6l4.4-2.8-4.4-2.8z" fill="#fff" />
      </svg>
    </span>
  );
}

export function Logo({ href = "/dashboard", iconOnly = false }: { href?: string; iconOnly?: boolean }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70">
      <LogoMark />
      {!iconOnly && <span className="text-[17px] font-semibold tracking-tight text-ink">ClipForge</span>}
    </Link>
  );
}

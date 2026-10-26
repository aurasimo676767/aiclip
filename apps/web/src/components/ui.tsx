import type { ReactNode } from "react";

/** Intestazione di pagina: titolo, sottotitolo e azioni a destra. */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight text-white sm:text-[1.85rem]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/[0.09] bg-white/[0.015] px-6 py-14 text-center">
      {icon && <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/[0.06] text-muted">{icon}</div>}
      <div>
        <p className="font-medium text-ink">{title}</p>
        {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Colore di un punteggio 0-100: stessa scala ovunque nel sito. Azzurro = i migliori, bianco = buoni, grigio = medi. */
export function scoreTone(score: number): { text: string; ring: string; bg: string } {
  if (score >= 82) return { text: "text-brand-300", ring: "#4f86ff", bg: "bg-brand-400/15" };
  if (score >= 70) return { text: "text-ink", ring: "#e9e9ee", bg: "bg-white/10" };
  if (score >= 60) return { text: "text-muted", ring: "#8a8a95", bg: "bg-white/5" };
  return { text: "text-faint", ring: "#55555f", bg: "bg-white/5" };
}

/** Punteggio complessivo su un tassello: i migliori pieni d'azzurro, gli altri scuri e discreti sopra la copertina. */
export function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
  const top = score >= 82;
  const good = score >= 70;
  return (
    <span
      title={`Punteggio ${score}/100`}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-semibold tabular-nums leading-none ${
        top ? "bg-brand-500 text-white" : good ? "bg-black/65 text-white ring-1 ring-white/15 backdrop-blur" : "bg-black/55 text-white/65 backdrop-blur"
      }`}
      style={{ fontSize: Math.round(size * 0.36), minWidth: Math.round(size * 0.9), height: Math.round(size * 0.6), paddingInline: Math.round(size * 0.14) }}
    >
      {score}
    </span>
  );
}

/** Piccolo riquadro numerico (statistiche). */
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3">
      <p className="text-xs font-medium text-faint">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Alert({ tone = "error", children }: { tone?: "error" | "success" | "info"; children: ReactNode }) {
  const styles = {
    error: "border-hot/30 bg-hot/10 text-[#ffc2c6]",
    success: "border-good/25 bg-good/10 text-[#b9f5d3]",
    info: "border-brand-400/25 bg-brand-500/10 text-brand-100",
  }[tone];
  return <div className={`rounded-xl border px-4 py-3 text-sm ${styles}`}>{children}</div>;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}:${String(rest).padStart(2, "0")}`;
}

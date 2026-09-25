import type { ReactNode } from "react";

/** Intestazione di pagina: titolo, sottotitolo e azioni a destra. */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line-strong px-6 py-14 text-center">
      {icon && <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-raised text-muted">{icon}</div>}
      <div>
        <p className="font-medium text-ink">{title}</p>
        {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Colore di un punteggio 0-100: stessa scala ovunque nel sito. */
export function scoreTone(score: number): { text: string; ring: string; bg: string } {
  if (score >= 85) return { text: "text-emerald-300", ring: "#34d399", bg: "bg-emerald-400/15" };
  if (score >= 72) return { text: "text-lime-300", ring: "#a3e635", bg: "bg-lime-400/15" };
  if (score >= 60) return { text: "text-amber-300", ring: "#fbbf24", bg: "bg-amber-400/15" };
  return { text: "text-zinc-300", ring: "#71717a", bg: "bg-zinc-500/15" };
}

/** Punteggio complessivo come anello, stile "virality score". */
export function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
  const tone = scoreTone(score);
  const stroke = Math.max(3, size / 12);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title={`Punteggio ${score}/100`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.12)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone.ring}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.min(100, Math.max(0, score)) / 100)}
        />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center font-display font-bold ${tone.text}`} style={{ fontSize: size * 0.34 }}>
        {score}
      </span>
    </div>
  );
}

/** Piccolo riquadro numerico (statistiche). */
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-raised/60 px-4 py-3">
      <p className="text-xs font-medium text-faint">{label}</p>
      <p className="mt-1 font-display text-lg font-semibold text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Alert({ tone = "error", children }: { tone?: "error" | "success" | "info"; children: ReactNode }) {
  const styles = {
    error: "border-red-500/30 bg-red-500/10 text-red-200",
    success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    info: "border-brand-400/30 bg-brand-500/10 text-brand-100",
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

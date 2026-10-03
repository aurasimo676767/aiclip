import type { ReactNode } from "react";

/** Intestazione di pagina: titolo, sottotitolo e azioni a destra. */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[1.7rem] font-extrabold leading-tight tracking-tight text-white sm:text-[2rem]" style={{ fontStretch: "110%" }}>
          {title}
        </h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-14 text-center">
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
// Solo i colori del sito (restyling 2026-10-03): il verde lime e lo smeraldo dei punteggi erano un
// quarto e quinto accento che litigavano col giallo. Giallo = i migliori, bianco = buoni, grigio = medi.
export function scoreTone(score: number): { text: string; ring: string; bg: string } {
  if (score >= 82) return { text: "text-brand-300", ring: "#ffd400", bg: "bg-brand-400/15" };
  if (score >= 70) return { text: "text-ink", ring: "#e9e5ef", bg: "bg-white/10" };
  if (score >= 60) return { text: "text-muted", ring: "#8d8699", bg: "bg-white/5" };
  return { text: "text-faint", ring: "#5a5466", bg: "bg-white/5" };
}

/**
 * Punteggio complessivo come un pezzo di sottotitolo: numero pesante e largo su un tassello. I
 * migliori (giallo pieno, col bordo nero sotto come le scritte degli Shorts) si riconoscono a colpo
 * d'occhio in una griglia di copertine; gli altri restano scuri e non rubano la scena all'immagine.
 * Prima era un anello di progresso: con nove copertine diventavano nove cerchi che si somigliavano.
 */
export function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
  const top = score >= 82;
  const good = score >= 70;
  return (
    <span
      title={`Punteggio ${score}/100`}
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-black tabular-nums leading-none ${
        top ? "bg-brand-400 text-on-brand shadow-slab" : good ? "bg-black/70 text-white ring-1 ring-white/15 backdrop-blur" : "bg-black/60 text-white/60 backdrop-blur"
      }`}
      style={{ fontSize: Math.round(size * 0.4), minWidth: Math.round(size * 0.92), height: Math.round(size * 0.66), paddingInline: Math.round(size * 0.14), fontStretch: "118%" }}
    >
      {score}
    </span>
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
    success: "border-white/10 bg-white/[0.04] text-ink",
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

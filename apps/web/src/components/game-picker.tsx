"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Gamepad2 } from "lucide-react";

/**
 * Quali giochi tenere nel video montato (simo, 2026-09-28): in una clip di un'ora possono esserci
 * 2-3 giochi, riconosciuti dall'AI guardando lo schermo; simo sceglie quali lasciare. Se non sceglie
 * niente resta il gioco che dura di più. Vale dal prossimo render.
 */
export function GamePicker({
  clipId,
  games,
  keep,
  compact = false,
}: {
  clipId: string;
  games: Array<{ name: string; seconds: number; contents?: string[] }> | null;
  keep: string[] | null;
  compact?: boolean;
}) {
  const router = useRouter();
  const main = games?.find((g) => g.name !== "Altro")?.name ?? null;
  const [picked, setPicked] = useState<string[]>(keep && keep.length > 0 ? keep : main ? [main] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!games) {
    return compact ? null : (
      <p className="flex items-center gap-2 text-xs text-muted">
        <Gamepad2 size={14} /> I giochi di questa clip non sono ancora stati riconosciuti: al prossimo render resta il gioco principale.
      </p>
    );
  }
  if (games.length < 2) return null;

  async function toggle(name: string) {
    const next = picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name];
    if (next.length === 0) return; // almeno un gioco resta sempre
    const before = picked;
    setPicked(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ longformKeepGames: next }),
      });
      if (!res.ok) {
        setPicked(before);
        setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Salvataggio non riuscito");
      } else router.refresh();
    } catch {
      setPicked(before);
      setError("Salvataggio non riuscito");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "flex flex-col gap-1.5" : "flex flex-col gap-2 rounded-xl border border-line bg-raised/50 p-3"}>
      <p className={`flex items-center gap-1.5 text-muted ${compact ? "text-[11px]" : "text-xs"}`}>
        <Gamepad2 size={compact ? 12 : 14} /> Giochi da tenere nel montato
      </p>
      <div className="flex flex-wrap gap-1.5">
        {games.map((g) => {
          const on = picked.includes(g.name);
          return (
            <button
              key={g.name}
              type="button"
              aria-pressed={on}
              disabled={busy}
              onClick={() => toggle(g.name)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70 disabled:opacity-60 ${
                on ? "border-brand-400 bg-brand-400/15 font-medium text-ink" : "border-line text-muted hover:border-line-strong hover:text-ink"
              }`}
            >
              {on && <Check size={12} strokeWidth={3} />}
              {g.name}
              <span className="tabular-nums text-faint">{Math.max(1, Math.round(g.seconds / 60))} min</span>
            </button>
          );
        })}
      </div>
      {(() => {
        const other = games.find((g) => g.name === "Altro")?.contents ?? [];
        return other.length > 0 ? <p className="text-[11px] leading-snug text-faint">Altro: {other.join(", ")}</p> : null;
      })()}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

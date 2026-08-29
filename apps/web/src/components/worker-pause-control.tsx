"use client";

import { useEffect, useState } from "react";

/**
 * Bottone globale pausa/ripresa del worker locale — non per singolo progetto, ferma/riprende
 * DAVVERO (a livello di sistema operativo) tutto quello che il worker sta facendo in quel
 * momento (download, ffmpeg, trascrizione), per liberare subito il PC quando serve.
 */
export function WorkerPauseControl() {
  const [paused, setPaused] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/worker-control");
        const data = await res.json();
        if (!cancelled && res.ok) setPaused(Boolean(data.paused));
      } catch {
        // silenzioso: se fallisce mostriamo semplicemente lo stato sconosciuto
      }
    }
    load();
    const interval = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function toggle() {
    if (paused === null) return;
    setSubmitting(true);
    setError(null);
    const next = !paused;
    try {
      const res = await fetch("/api/worker-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Aggiornamento fallito");
      setPaused(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSubmitting(false);
    }
  }

  if (paused === null) return null;

  return (
    <div className="space-y-1">
      <button
        onClick={toggle}
        disabled={submitting}
        className={`w-full rounded-lg border px-3 py-2 text-left text-sm font-medium transition disabled:opacity-50 ${
          paused
            ? "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20"
            : "border-zinc-700 text-zinc-300 hover:bg-zinc-800/60"
        }`}
        title="Ferma/riprende davvero i processi pesanti del worker (download, ffmpeg, trascrizione) — non solo tra una fase e l'altra"
      >
        {submitting ? "..." : paused ? "⏸ Worker in pausa — riprendi" : "⏸ Metti in pausa il worker"}
      </button>
      {error && <p className="px-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";

/**
 * Bottone globale pausa/ripresa del worker locale — non per singolo progetto, ferma/riprende
 * DAVVERO (a livello di sistema operativo) tutto quello che il worker sta facendo in quel
 * momento (download, ffmpeg, trascrizione), per liberare subito il PC quando serve.
 */
export function WorkerPauseControl({ compact = false }: { compact?: boolean }) {
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

  const title = paused
    ? "Worker in pausa: clicca per riprendere download, ffmpeg e trascrizione"
    : "Ferma davvero i processi pesanti del worker (download, ffmpeg, trascrizione), non solo tra una fase e l'altra";

  if (compact) {
    return (
      <button
        onClick={toggle}
        disabled={submitting}
        title={title}
        className={`flex w-full items-center justify-center rounded-lg py-2 transition disabled:opacity-50 ${
          paused ? "bg-amber-500/15 text-amber-300" : "text-faint hover:bg-raised/60 hover:text-ink"
        }`}
      >
        {paused ? <Play size={18} /> : <Pause size={18} />}
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <button
        onClick={toggle}
        disabled={submitting}
        title={title}
        className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition disabled:opacity-50 ${
          paused ? "border-amber-500/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/15" : "border-line bg-raised/50 text-muted hover:border-line-strong hover:text-ink"
        }`}
      >
        <span className="relative flex h-2 w-2">
          {!paused && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${paused ? "bg-amber-400" : "bg-emerald-400"}`} />
        </span>
        <span className="flex-1">
          <span className="block text-xs font-medium text-ink">{paused ? "Worker in pausa" : "Worker attivo"}</span>
          <span className="block text-[11px] text-faint">{submitting ? "..." : paused ? "Clicca per riprendere" : "Clicca per mettere in pausa"}</span>
        </span>
        {paused ? <Play size={15} /> : <Pause size={15} />}
      </button>
      {error && <p className="px-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

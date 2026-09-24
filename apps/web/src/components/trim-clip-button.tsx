"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Scissors } from "lucide-react";

interface TrimPanelProps {
  clipId: string;
  duration: number;
  /** Secondo corrente del player della clip, per "inizio qui"/"fine qui". */
  getCurrentTime?: () => number | null;
  onDone: () => void;
  onCancel: () => void;
}

/** Accorcia una clip già renderizzata spostando inizio e fine (rigenera il video). */
export function TrimPanel({ clipId, duration, getCurrentTime, onDone, onCancel }: TrimPanelProps) {
  const router = useRouter();
  const [startOffset, setStartOffset] = useState(0);
  const [endOffset, setEndOffset] = useState(Math.round(duration * 10) / 10);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const newDuration = endOffset - startOffset;

  function fromPlayer(set: (value: number) => void) {
    const t = getCurrentTime?.();
    if (t !== null && t !== undefined) set(Math.round(t * 10) / 10);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newStartOffset: startOffset, newEndOffset: endOffset }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Taglio fallito");
      router.refresh();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSubmitting(false);
    }
  }

  const startPct = (startOffset / duration) * 100;
  const endPct = (endOffset / duration) * 100;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <p className="section-title">Taglia la clip</p>
        <p className="mt-0.5 text-xs text-muted">Sposta inizio e fine: il video viene rigenerato (qualche minuto).</p>
      </div>

      {/* Barra che mostra la parte tenuta */}
      <div className="relative h-2 rounded-full bg-overlay">
        <div className="absolute inset-y-0 rounded-full bg-brand-gradient" style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Inizia da (s)</label>
          <input type="number" min={0} max={endOffset - 3} step={0.1} value={startOffset} onChange={(e) => setStartOffset(Number(e.target.value))} className="input tabular-nums" />
          {getCurrentTime && (
            <button type="button" onClick={() => fromPlayer(setStartOffset)} className="mt-1.5 text-xs text-brand-300 hover:text-brand-200">
              Inizio qui ▸
            </button>
          )}
        </div>
        <div>
          <label className="label">Termina a (s)</label>
          <input type="number" min={startOffset + 3} max={duration} step={0.1} value={endOffset} onChange={(e) => setEndOffset(Number(e.target.value))} className="input tabular-nums" />
          {getCurrentTime && (
            <button type="button" onClick={() => fromPlayer(setEndOffset)} className="mt-1.5 text-xs text-brand-300 hover:text-brand-200">
              ◂ Fine qui
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted">
        Nuova durata: <span className="font-medium tabular-nums text-ink">{newDuration.toFixed(1)}s</span> su {duration.toFixed(1)}s
      </p>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button type="submit" disabled={submitting || newDuration < 3} className="btn btn-primary btn-sm">
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <Scissors size={14} />}
          {submitting ? "Applico…" : "Applica taglio"}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">
          Indietro
        </button>
      </div>
    </form>
  );
}

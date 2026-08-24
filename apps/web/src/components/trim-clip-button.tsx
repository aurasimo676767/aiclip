"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface TrimClipButtonProps {
  clipId: string;
  duration: number;
}

export function TrimClipButton({ clipId, duration }: TrimClipButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [startOffset, setStartOffset] = useState(0);
  const [endOffset, setEndOffset] = useState(duration);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => {
          setStartOffset(0);
          setEndOffset(duration);
          setOpen(true);
        }}
        className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500"
      >
        Modifica durata
      </button>
    );
  }

  const newDuration = endOffset - startOffset;

  return (
    <form onSubmit={handleSubmit} className="mt-2 max-w-md space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <p className="text-xs text-zinc-500">
        Sposta inizio/fine per accorciare la clip (0s - {duration.toFixed(1)}s). Rigenera il video — richiede qualche minuto.
      </p>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-xs text-zinc-500">Inizia da (s)</label>
          <input
            type="number"
            min={0}
            max={endOffset - 3}
            step={0.5}
            value={startOffset}
            onChange={(e) => setStartOffset(Number(e.target.value))}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-white outline-none focus:border-brand-400"
          />
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-xs text-zinc-500">Termina a (s)</label>
          <input
            type="number"
            min={startOffset + 3}
            max={duration}
            step={0.5}
            value={endOffset}
            onChange={(e) => setEndOffset(Number(e.target.value))}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-white outline-none focus:border-brand-400"
          />
        </div>
      </div>

      <p className="text-xs text-zinc-500">Nuova durata: {newDuration.toFixed(1)}s</p>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={submitting || newDuration < 3}
          className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {submitting ? "Applico..." : "Applica taglio"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500"
        >
          Annulla
        </button>
      </div>
    </form>
  );
}

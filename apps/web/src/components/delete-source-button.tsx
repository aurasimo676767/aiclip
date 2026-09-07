"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Tasto "Elimina sorgente": cancella il video originale ovunque (R2 + cache locale del worker),
 * lasciando intatte le clip già renderizzate. Serve per liberare spazio quando lo si decide,
 * invece che farlo scattare da solo — vedi cleanup-source.ts nel worker.
 */
export function DeleteSourceButton({ projectId, compact }: { projectId: string; compact?: boolean }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    if (
      !window.confirm(
        "Eliminare il video sorgente di questo progetto (da R2 e dal disco locale)? Le clip già renderizzate restano intatte. Se in futuro servono altre clip da questo video, andrà riscaricato da capo.",
      )
    ) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/delete-source`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancellazione fallita");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={compact ? "space-y-1" : "mt-2 space-y-1"}>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        onClick={handleClick}
        disabled={submitting}
        title="Elimina il video sorgente da R2 e dal disco locale"
        className="rounded-lg border border-zinc-700 px-2 py-1.5 text-xs font-medium text-zinc-400 hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
      >
        {submitting ? "..." : "🗑"}
      </button>
    </div>
  );
}

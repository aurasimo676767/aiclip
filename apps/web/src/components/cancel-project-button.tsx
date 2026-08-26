"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CancelProjectButton({ projectId, compact }: { projectId: string; compact?: boolean }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(e: React.MouseEvent) {
    // Il bottone può stare dentro una <Link> (card della dashboard): evita che il click
    // navighi verso il progetto invece di annullarlo.
    e.preventDefault();
    e.stopPropagation();

    if (!window.confirm("Annullare l'elaborazione di questo progetto?")) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Annullamento fallito");
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
        className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
      >
        {submitting ? "Annullo..." : "Annulla"}
      </button>
    </div>
  );
}

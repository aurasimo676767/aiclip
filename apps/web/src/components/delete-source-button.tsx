"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { useConfirm } from "./ui-kit/confirm";

/**
 * Tasto "Elimina sorgente": cancella il video originale ovunque (R2 + cache locale del worker),
 * lasciando intatte le clip già renderizzate. Serve per liberare spazio quando lo si decide,
 * invece che farlo scattare da solo — vedi cleanup-source.ts nel worker.
 */
export function DeleteSourceButton({ projectId, compact }: { projectId: string; compact?: boolean }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    const ok = await confirm({
      title: "Eliminare il video sorgente?",
      description:
        "Viene cancellato da R2 e dal disco del PC. Le clip già renderizzate restano intatte, ma per crearne altre da questo video andrà riscaricato da capo.",
      confirmLabel: "Elimina sorgente",
      destructive: true,
    });
    if (!ok) return;

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
      {confirm.element}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        onClick={handleClick}
        disabled={submitting}
        title="Elimina il video sorgente da R2 e dal disco locale"
        className="btn btn-secondary btn-sm hover:border-red-500/50 hover:text-red-300"
      >
        <Trash2 size={14} />
        {compact ? (submitting ? "…" : "") : submitting ? "Elimino…" : "Elimina sorgente"}
      </button>
    </div>
  );
}

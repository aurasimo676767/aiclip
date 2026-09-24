"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useConfirm } from "./ui-kit/confirm";

export function CancelProjectButton({ projectId, compact }: { projectId: string; compact?: boolean }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  async function handleClick(e: React.MouseEvent) {
    // Il bottone può stare dentro una <Link> (card della dashboard): evita che il click
    // navighi verso il progetto invece di annullarlo.
    e.preventDefault();
    e.stopPropagation();

    const ok = await confirm({
      title: "Annullare l'elaborazione?",
      description: "Il worker smette di lavorare su questo video. Potrai riprovare più tardi.",
      confirmLabel: "Annulla elaborazione",
      destructive: true,
    });
    if (!ok) return;

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
      {confirm.element}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        onClick={handleClick}
        disabled={submitting}
        className="btn btn-secondary btn-sm"
      >
        <X size={14} />
        {submitting ? "Annullo…" : "Annulla"}
      </button>
    </div>
  );
}

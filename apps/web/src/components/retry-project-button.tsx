"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";

export function RetryProjectButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/retry`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Riprova fallita");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-2 space-y-1">
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        onClick={handleClick}
        disabled={submitting}
        className="btn btn-danger btn-sm"
      >
        <RotateCcw size={14} />
        {submitting ? "Rimetto in coda…" : "Riprova"}
      </button>
    </div>
  );
}

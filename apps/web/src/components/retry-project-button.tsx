"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
        className="rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-200 hover:border-red-400 disabled:opacity-50"
      >
        {submitting ? "Rimetto in coda..." : "Riprova"}
      </button>
    </div>
  );
}

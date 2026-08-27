"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function MarkYoutubeDeletedButton({ clipId }: { clipId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (
      !window.confirm(
        "Segnalo come eliminato manualmente da YouTube? Lo slot torna libero e la clip diventa di nuovo programmabile.",
      )
    )
      return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/mark-youtube-deleted`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Operazione fallita");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        onClick={handleClick}
        disabled={submitting}
        className="shrink-0 rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs font-medium text-zinc-400 hover:border-red-400 hover:text-red-300 disabled:opacity-50"
        title="Segna come eliminato a mano da YouTube — libera lo slot per una nuova programmazione"
      >
        {submitting ? "..." : "Eliminato su YouTube"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

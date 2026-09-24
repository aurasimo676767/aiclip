"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { useConfirm } from "./ui-kit/confirm";
import { Tip } from "./ui-kit/menu";

export function MarkYoutubeDeletedButton({ clipId }: { clipId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  async function handleClick() {
    const ok = await confirm({
      title: "Segnare come eliminato da YouTube?",
      description: "Usalo se hai cancellato il video a mano su YouTube: lo slot torna libero e la clip diventa di nuovo programmabile.",
      confirmLabel: "Segna come eliminato",
      destructive: true,
    });
    if (!ok) return;
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
      <Tip label="Eliminato a mano da YouTube? Libera lo slot">
        <button onClick={handleClick} disabled={submitting} className="btn btn-ghost btn-sm hover:text-red-300" aria-label="Segna come eliminato da YouTube">
          <Trash2 size={14} />
        </button>
      </Tip>
      {confirm.element}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

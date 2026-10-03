"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Loader2, Undo2 } from "lucide-react";
import type { DiscardedShort } from "@clipforge/shared";
import { formatDuration } from "./ui";

/** Shorts che l'AI ha trovato ma scartato, con il motivo: si possono recuperare e generare. */
export function DiscardedShortsPanel({ videoId, items }: { videoId: string; items: DiscardedShort[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function recover(item: DiscardedShort) {
    setBusy(item.start);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/discarded`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: item.start, title: item.title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Recupero fallito");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card p-5 sm:p-6">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={open}>
        <span>
          <span className="font-display text-base font-semibold text-ink">Shorts scartati dall&apos;AI ({items.length})</span>
          <span className="mt-0.5 block text-xs text-muted">Trovati nel video ma non generati. Se uno ti convince, recuperalo.</span>
        </span>
        <ChevronDown size={18} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="mt-4 divide-y divide-line">
          {items.map((item) => (
            <li key={`${item.start}-${item.title}`} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="break-words text-sm font-medium text-ink">{item.title}</p>
                <p className="text-xs text-red-200/90">{item.reason}</p>
                {item.aiReason && <p className="text-xs text-muted">{item.aiReason}</p>}
                <p className="text-xs tabular-nums text-faint">
                  da {formatDuration(item.start)} · {formatDuration(item.duration)} · voto {item.score}
                </p>
              </div>
              <button type="button" onClick={() => recover(item)} disabled={busy !== null} className="btn btn-secondary btn-sm shrink-0">
                {busy === item.start ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
                Recupera e genera
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
    </section>
  );
}

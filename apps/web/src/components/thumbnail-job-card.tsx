"use client";

import { useState } from "react";

export interface ThumbnailJobViewModel {
  id: string;
  clipTitle: string;
  status: string;
  errorMessage: string | null;
  youtubeThumbnailSet: boolean;
  createdAt: string;
}

export function ThumbnailJobCard({ job }: { job: ThumbnailJobViewModel }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadPreview() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/thumbnails/${job.id}/preview`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Impossibile caricare l'anteprima");
      setPreviewUrl(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setLoading(false);
    }
  }

  return (
    <li className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-sm text-white">{job.clipTitle}</span>
        <StatusPill status={job.status} />
      </div>

      {job.status === "FAILED" && job.errorMessage && <p className="text-xs text-red-400">Errore: {job.errorMessage}</p>}

      {job.status === "COMPLETED" && (
        <>
          {previewUrl ? (
            <img src={previewUrl} alt={job.clipTitle} className="w-full max-w-md rounded-lg border border-zinc-800" />
          ) : (
            <button
              onClick={loadPreview}
              disabled={loading}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
            >
              {loading ? "Caricamento..." : "Mostra anteprima"}
            </button>
          )}
          {previewUrl && (
            <a href={previewUrl} download className="block text-xs text-brand-300 hover:underline">
              Scarica immagine
            </a>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <p className="text-xs text-zinc-500">
            {job.youtubeThumbnailSet
              ? "Impostata automaticamente come copertina del video su YouTube."
              : "Generata, ma non è stato possibile impostarla automaticamente su YouTube — scaricala e caricala a mano da YouTube Studio."}
          </p>
        </>
      )}
    </li>
  );
}

function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = {
    PENDING: "In coda",
    PROCESSING: "In elaborazione...",
    COMPLETED: "Pronta",
    FAILED: "Fallita",
  };
  const color: Record<string, string> = {
    PENDING: "bg-zinc-700 text-zinc-200",
    PROCESSING: "bg-amber-500/15 text-amber-300",
    COMPLETED: "bg-emerald-500/15 text-emerald-300",
    FAILED: "bg-red-500/15 text-red-300",
  };
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${color[status] ?? "bg-zinc-700 text-zinc-200"}`}>
      {label[status] ?? status}
    </span>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "./status-badge";

export interface VoiceoverJobViewModel {
  id: string;
  title: string;
  status: string;
  errorMessage: string | null;
  videoFilename: string;
  audioFilename: string;
  createdAt: string;
}

export function VoiceoverJobList({ jobs }: { jobs: VoiceoverJobViewModel[] }) {
  const router = useRouter();
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadPreview(jobId: string) {
    setPreviewLoading(jobId);
    setError(null);
    try {
      const res = await fetch(`/api/voiceover/${jobId}/download`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Impossibile caricare la clip");
      setPreviewUrls((prev) => ({ ...prev, [jobId]: data.url }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setPreviewLoading(null);
    }
  }

  async function retry(jobId: string) {
    setRetryingId(jobId);
    setError(null);
    try {
      const res = await fetch(`/api/voiceover/${jobId}/retry`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Riprova fallita");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setRetryingId(null);
    }
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
        Nessuna clip ancora. Caricane una qui sopra.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-400">{error}</p>}
      <ul className="space-y-3">
        {jobs.map((job) => {
          const previewUrl = previewUrls[job.id];
          return (
            <li key={job.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="break-words font-medium text-white">{job.title}</h3>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {job.videoFilename} + {job.audioFilename}
                  </p>
                </div>
                <StatusBadge status={job.status} />
              </div>

              {job.status === "FAILED" && (
                <div className="mt-2 space-y-1">
                  <p className="text-sm text-red-400">Errore: {job.errorMessage ?? "sconosciuto"}</p>
                  <button
                    onClick={() => retry(job.id)}
                    disabled={retryingId === job.id}
                    className="rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-medium text-red-200 hover:border-red-400 disabled:opacity-50"
                  >
                    {retryingId === job.id ? "Rimetto in coda..." : "Riprova"}
                  </button>
                </div>
              )}

              {job.status === "COMPLETED" && (
                <div className="mt-3">
                  {previewUrl ? (
                    <>
                      <video src={previewUrl} controls className="aspect-[9/16] w-48 rounded-lg bg-black" />
                      <a href={previewUrl} download className="mt-2 inline-block text-xs text-brand-300 hover:underline">
                        Scarica MP4
                      </a>
                    </>
                  ) : (
                    <button
                      onClick={() => loadPreview(job.id)}
                      disabled={previewLoading === job.id}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500"
                    >
                      {previewLoading === job.id ? "Caricamento..." : "Preview"}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

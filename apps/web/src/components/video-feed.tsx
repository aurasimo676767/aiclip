"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { FeedVideo } from "@/app/api/channels/feed/route";

export function VideoFeed() {
  const router = useRouter();
  const [videos, setVideos] = useState<FeedVideo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [showImported, setShowImported] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/channels/feed");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Caricamento feed fallito");
      setVideos(data.videos as FeedVideo[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleGenerate(video: FeedVideo) {
    setGeneratingId(video.videoId);
    setError(null);
    try {
      const res = await fetch("/api/projects/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${video.videoId}` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Creazione progetto fallita");
      router.push(`/dashboard/projects/${data.projectId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
      setGeneratingId(null);
    }
  }

  const newVideos = videos?.filter((v) => !v.alreadyImported) ?? [];
  const importedVideos = videos?.filter((v) => v.alreadyImported) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-600">{videos ? `${newVideos.length} nuovi` : ""}</p>
        <button
          onClick={load}
          disabled={loading}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
        >
          {loading ? "Aggiorno..." : "Aggiorna"}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading && !videos ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center text-sm text-zinc-500">Carico il feed...</div>
      ) : videos && videos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center text-sm text-zinc-500">
          Nessun video trovato per i canali che segui.
        </div>
      ) : (
        <>
          {newVideos.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center text-sm text-zinc-500">
              Nessun video nuovo — li hai già generati tutti.
            </div>
          ) : (
            <VideoGrid videos={newVideos} generatingId={generatingId} onGenerate={handleGenerate} />
          )}

          {importedVideos.length > 0 && (
            <div className="border-t border-zinc-800 pt-4">
              <button
                onClick={() => setShowImported((prev) => !prev)}
                className="text-xs font-medium text-zinc-500 hover:text-zinc-300"
              >
                {showImported ? "▾" : "▸"} Già generati ({importedVideos.length})
              </button>
              {showImported && (
                <div className="mt-3">
                  <VideoGrid videos={importedVideos} generatingId={generatingId} onGenerate={handleGenerate} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function VideoGrid({
  videos,
  generatingId,
  onGenerate,
}: {
  videos: FeedVideo[];
  generatingId: string | null;
  onGenerate: (video: FeedVideo) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {videos.map((video) => (
        <div key={video.videoId} className="flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
          <div className="aspect-video w-full bg-zinc-950">
            {video.thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={video.thumbnailUrl} alt={video.title} className="h-full w-full object-cover" />
            )}
          </div>
          <div className="flex flex-1 flex-col gap-2 p-3">
            <h3 className="line-clamp-2 text-sm font-medium text-white">{video.title}</h3>
            <p className="text-xs text-zinc-500">{video.channelTitle}</p>
            <div className="mt-auto flex items-center justify-between gap-2 pt-1">
              <span className="text-xs text-zinc-500">
                {formatViewCount(video.viewCount)} • {formatRelativeTime(video.publishedAt)}
              </span>
              <button
                onClick={() => onGenerate(video)}
                disabled={generatingId === video.videoId || video.alreadyImported}
                className="shrink-0 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {video.alreadyImported ? "Già generato" : generatingId === video.videoId ? "Genero..." : "Genera"}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatViewCount(count: number | null): string {
  if (count === null) return "— visualizzazioni";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M visualizzazioni`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K visualizzazioni`;
  return `${count} visualizzazioni`;
}

function formatRelativeTime(iso: string): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "oggi";
  if (diffDays === 1) return "1 giorno fa";
  if (diffDays < 30) return `${diffDays} giorni fa`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} mes${diffMonths === 1 ? "e" : "i"} fa`;
  const diffYears = Math.floor(diffMonths / 12);
  return `${diffYears} ann${diffYears === 1 ? "o" : "i"} fa`;
}

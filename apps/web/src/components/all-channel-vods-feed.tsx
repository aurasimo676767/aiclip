"use client";

import { useEffect, useState, useCallback } from "react";
import type { TwitchFeedVideo } from "@/app/api/channels/twitch-feed/route";

/**
 * Tutti i VOD di UN canale Twitch (non solo gli ultimi 6 come nel feed misto), con un tasto per
 * generarli TUTTI in un colpo solo — vedi /api/twitch-channels/[id]/vods e
 * /api/projects/twitch/bulk. Serve a chi vuole "svuotare" un canale alla volta invece di dover
 * scorrere un feed misto tra tutti i canali seguiti.
 */
export function AllChannelVodsFeed({ channelId }: { channelId: string }) {
  const [videos, setVideos] = useState<TwitchFeedVideo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/twitch-channels/${channelId}/vods`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Caricamento VOD fallito");
      setVideos(data.videos as TwitchFeedVideo[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleGenerateOne(video: TwitchFeedVideo) {
    setGeneratingId(video.vodId);
    setError(null);
    try {
      const res = await fetch("/api/projects/twitch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: video.vodUrl, title: video.title, streamerName: video.streamerName, streamerLogin: video.streamerLogin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Creazione progetto fallita");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setGeneratingId(null);
    }
  }

  async function handleGenerateAll() {
    if (!videos) return;
    const newVideos = videos.filter((v) => !v.alreadyImported);
    if (newVideos.length === 0) return;
    if (!window.confirm(`Generare tutti e ${newVideos.length} i VOD nuovi di questo canale? Verranno messi tutti in coda.`)) return;

    setGeneratingAll(true);
    setError(null);
    setBulkResult(null);
    try {
      const res = await fetch("/api/projects/twitch/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videos: newVideos.map((v) => ({ url: v.vodUrl, title: v.title, streamerName: v.streamerName, streamerLogin: v.streamerLogin })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generazione in blocco fallita");
      const created = (data.projectIds as string[]).length;
      const failed = (data.errors as Array<{ url: string; error: string }>).length;
      setBulkResult(failed > 0 ? `${created} VOD messi in coda, ${failed} falliti` : `${created} VOD messi in coda`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setGeneratingAll(false);
    }
  }

  const newVideos = videos?.filter((v) => !v.alreadyImported) ?? [];
  const importedVideos = videos?.filter((v) => v.alreadyImported) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-600">{videos ? `${newVideos.length} nuovi su ${videos.length} totali` : ""}</p>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
          >
            {loading ? "Aggiorno..." : "Aggiorna"}
          </button>
          <button
            onClick={handleGenerateAll}
            disabled={generatingAll || newVideos.length === 0}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {generatingAll ? "Genero tutti..." : `Genera tutti (${newVideos.length})`}
          </button>
        </div>
      </div>

      {bulkResult && <p className="text-sm text-emerald-400">{bulkResult}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading && !videos ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center text-sm text-zinc-500">Carico i VOD...</div>
      ) : videos && videos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center text-sm text-zinc-500">
          Nessun VOD disponibile per questo canale (Twitch li tiene solo per un periodo limitato).
        </div>
      ) : (
        <>
          {newVideos.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center text-sm text-zinc-500">
              Nessun VOD nuovo — li hai già generati tutti.
            </div>
          ) : (
            <VodGrid videos={newVideos} generatingId={generatingId} onGenerate={handleGenerateOne} />
          )}

          {importedVideos.length > 0 && (
            <div className="border-t border-zinc-800 pt-4">
              <p className="mb-3 text-xs font-medium text-zinc-500">Già generati ({importedVideos.length})</p>
              <VodGrid videos={importedVideos} generatingId={generatingId} onGenerate={handleGenerateOne} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function VodGrid({
  videos,
  generatingId,
  onGenerate,
}: {
  videos: TwitchFeedVideo[];
  generatingId: string | null;
  onGenerate: (video: TwitchFeedVideo) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {videos.map((video) => (
        <div key={video.vodId} className="flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
          <div className="aspect-video w-full bg-zinc-950">
            {video.thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={video.thumbnailUrl} alt={video.title} className="h-full w-full object-cover" />
            )}
          </div>
          <div className="flex flex-1 flex-col gap-2 p-3">
            <h3 className="line-clamp-2 text-sm font-medium text-white">{video.title}</h3>
            <div className="mt-auto flex items-center justify-between gap-2 pt-1">
              <span className="text-xs text-zinc-500">
                {formatDuration(video.durationSeconds)} • {formatRelativeTime(video.createdAt)}
              </span>
              <button
                onClick={() => onGenerate(video)}
                disabled={generatingId === video.vodId || video.alreadyImported}
                className="shrink-0 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {video.alreadyImported ? "Già generato" : generatingId === video.vodId ? "Genero..." : "Genera"}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}min`;
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

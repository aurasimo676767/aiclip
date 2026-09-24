"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { FeedVideo } from "@/app/api/channels/feed/route";
import { FeedGrid, RefreshButton, formatRelativeTime } from "./feed-grid";
import { Alert } from "./ui";

export function VideoFeed() {
  const router = useRouter();
  const [videos, setVideos] = useState<FeedVideo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);

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

  async function handleGenerate(videoId: string) {
    setGeneratingId(videoId);
    setError(null);
    try {
      const res = await fetch("/api/projects/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Creazione progetto fallita");
      router.push(`/dashboard/projects/${data.projectId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
      setGeneratingId(null);
    }
  }

  const newCount = videos?.filter((v) => !v.alreadyImported).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">{videos ? `${newCount} nuovi` : ""}</p>
        <RefreshButton loading={loading} onClick={load} />
      </div>
      {error && <Alert>{error}</Alert>}
      <FeedGrid
        loading={loading}
        generatingId={generatingId}
        onGenerate={handleGenerate}
        emptyText="Nessun video trovato per i canali che segui."
        items={
          videos?.map((v) => ({
            id: v.videoId,
            title: v.title,
            thumbnailUrl: v.thumbnailUrl,
            subtitle: v.channelTitle,
            meta: `${formatViewCount(v.viewCount)} · ${formatRelativeTime(v.publishedAt)}`,
            alreadyImported: v.alreadyImported,
          })) ?? null
        }
      />
    </div>
  );
}

function formatViewCount(count: number | null): string {
  if (count === null) return "— visualizzazioni";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M visualizzazioni`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K visualizzazioni`;
  return `${count} visualizzazioni`;
}

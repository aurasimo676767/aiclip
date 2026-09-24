"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { TwitchFeedVideo } from "@/app/api/channels/twitch-feed/route";
import { FeedGrid, RefreshButton, formatRelativeTime, formatVodDuration } from "./feed-grid";
import { Alert } from "./ui";

export function TwitchVideoFeed() {
  const router = useRouter();
  const [videos, setVideos] = useState<TwitchFeedVideo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/channels/twitch-feed");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Caricamento feed fallito");
      setVideos(data.videos as TwitchFeedVideo[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleGenerate(vodId: string) {
    const video = videos?.find((v) => v.vodId === vodId);
    if (!video) return;
    setGeneratingId(vodId);
    setError(null);
    try {
      const res = await fetch("/api/projects/twitch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: video.vodUrl, title: video.title, streamerName: video.streamerName, streamerLogin: video.streamerLogin }),
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
        emptyText="Nessun VOD trovato per i canali Twitch che segui."
        items={
          videos?.map((v) => ({
            id: v.vodId,
            title: v.title,
            thumbnailUrl: v.thumbnailUrl,
            badge: formatVodDuration(v.durationSeconds),
            subtitle: (
              <Link href={`/dashboard/feed/twitch/${v.channelId}`} className="hover:text-brand-300">
                {v.streamerName} · tutti i VOD →
              </Link>
            ),
            meta: formatRelativeTime(v.createdAt),
            alreadyImported: v.alreadyImported,
          })) ?? null
        }
      />
    </div>
  );
}

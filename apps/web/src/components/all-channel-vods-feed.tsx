"use client";

import { useEffect, useState, useCallback } from "react";
import { Layers, Loader2 } from "lucide-react";
import type { TwitchFeedVideo } from "@/app/api/channels/twitch-feed/route";
import { FeedGrid, RefreshButton, formatRelativeTime, formatVodDuration } from "./feed-grid";
import { useConfirm } from "./ui-kit/confirm";
import { Alert } from "./ui";

/**
 * Tutti i VOD di UN canale Twitch (non solo gli ultimi 6 come nel feed misto), con un tasto per
 * generarli TUTTI in un colpo solo — vedi /api/twitch-channels/[id]/vods e
 * /api/projects/twitch/bulk. Serve a chi vuole "svuotare" un canale alla volta invece di dover
 * scorrere un feed misto tra tutti i canali seguiti.
 */
export function AllChannelVodsFeed({ channelId }: { channelId: string }) {
  const confirm = useConfirm();
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

  async function handleGenerateOne(vodId: string) {
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
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setGeneratingId(null);
    }
  }

  const newVideos = videos?.filter((v) => !v.alreadyImported) ?? [];

  async function handleGenerateAll() {
    if (newVideos.length === 0) return;
    const ok = await confirm({
      title: `Generare tutti e ${newVideos.length} i VOD nuovi?`,
      description: "Vengono messi tutti in coda al worker, uno dopo l'altro.",
      confirmLabel: `Genera ${newVideos.length} VOD`,
    });
    if (!ok) return;

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">{videos ? `${newVideos.length} nuovi su ${videos.length} totali` : ""}</p>
        <div className="flex items-center gap-2">
          <RefreshButton loading={loading} onClick={load} />
          <button onClick={handleGenerateAll} disabled={generatingAll || newVideos.length === 0} className="btn btn-gradient btn-sm">
            {generatingAll ? <Loader2 size={14} className="animate-spin" /> : <Layers size={14} />}
            {generatingAll ? "Metto in coda…" : `Genera tutti (${newVideos.length})`}
          </button>
        </div>
      </div>

      {bulkResult && <Alert tone="success">{bulkResult}</Alert>}
      {error && <Alert>{error}</Alert>}

      <FeedGrid
        loading={loading}
        generatingId={generatingId}
        onGenerate={handleGenerateOne}
        emptyText="Nessun VOD disponibile per questo canale (Twitch li tiene solo per un periodo limitato)."
        items={
          videos?.map((v) => ({
            id: v.vodId,
            title: v.title,
            thumbnailUrl: v.thumbnailUrl,
            badge: formatVodDuration(v.durationSeconds),
            meta: formatRelativeTime(v.createdAt),
            alreadyImported: v.alreadyImported,
          })) ?? null
        }
      />
      {confirm.element}
    </div>
  );
}

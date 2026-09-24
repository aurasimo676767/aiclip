"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function YoutubeConnectionPanel({ channelTitle }: { channelTitle: string | null }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDisconnect() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/youtube/disconnect", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Disconnessione fallita");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setLoading(false);
    }
  }

  if (channelTitle) {
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-sm text-muted">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          Connesso come <span className="font-medium text-ink">{channelTitle}</span>
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          onClick={handleDisconnect}
          disabled={loading}
          className="btn btn-secondary btn-sm"
        >
          {loading ? "Disconnetto…" : "Disconnetti"}
        </button>
      </div>
    );
  }

  return (
    <a
      href="/api/youtube/connect"
      className="btn btn-primary"
    >
      Connetti YouTube
    </a>
  );
}

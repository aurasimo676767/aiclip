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
        <p className="text-sm text-zinc-300">
          Connesso come <span className="font-medium text-white">{channelTitle}</span>
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          onClick={handleDisconnect}
          disabled={loading}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
        >
          {loading ? "Disconnessione..." : "Disconnetti"}
        </button>
      </div>
    );
  }

  return (
    <a
      href="/api/youtube/connect"
      className="inline-block rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-600"
    >
      Connetti YouTube
    </a>
  );
}

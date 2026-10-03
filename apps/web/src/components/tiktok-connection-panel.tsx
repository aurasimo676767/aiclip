"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Collegamento dell'account TikTok su cui pubblicare (Login Kit): nome e foto dell'account, scollega. */
export function TiktokConnectionPanel({ displayName, avatarUrl }: { displayName: string | null; avatarUrl: string | null }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDisconnect() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tiktok/disconnect", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Disconnessione fallita");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setLoading(false);
    }
  }

  if (displayName !== null) {
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-sm text-muted">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" className="h-6 w-6 rounded-full" />
          ) : (
            <span className="h-2 w-2 rounded-full bg-brand-400" />
          )}
          Connesso come <span className="font-medium text-ink">{displayName || "account TikTok"}</span>
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button onClick={handleDisconnect} disabled={loading} className="btn btn-secondary btn-sm">
          {loading ? "Disconnetto…" : "Disconnetti"}
        </button>
      </div>
    );
  }

  return (
    <a href="/api/tiktok/connect" className="btn btn-primary">
      Connetti TikTok
    </a>
  );
}

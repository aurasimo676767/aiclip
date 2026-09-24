"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ThumbnailGeneratorForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [reactedUrl, setReactedUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/thumbnails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtubeUrl: url, reactedVideoUrl: reactedUrl.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Creazione fallita");
      setUrl("");
      setReactedUrl("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-lg border border-line bg-surface p-4">
      <div>
        <label className="mb-1 block text-xs text-muted">Link del tuo video pubblicato</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=..."
          className="w-full rounded-md border border-line-strong bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-brand-400"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted">
          Link del video ORIGINALE reagito (opzionale, ma consigliato — se lo sai, evita che l&apos;IA debba indovinarlo)
        </label>
        <input
          value={reactedUrl}
          onChange={(e) => setReactedUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=... (il video che reagite/guardate)"
          className="w-full rounded-md border border-line-strong bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-brand-400"
        />
      </div>
      <button
        type="submit"
        disabled={submitting || !url.trim()}
        className="btn btn-primary"
      >
        {submitting ? "Avvio..." : "Genera copertina"}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}

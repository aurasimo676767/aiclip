"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ThumbnailGeneratorForm({ people }: { people: string[] }) {
  const router = useRouter();
  // In ordine di scelta: il primo toccato è il protagonista della copertina.
  const [chosen, setChosen] = useState<string[]>([]);
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
        body: JSON.stringify({ youtubeUrl: url, reactedVideoUrl: reactedUrl.trim() || undefined, people: chosen.length ? chosen : undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Creazione fallita");
      setUrl("");
      setReactedUrl("");
      setChosen([]);
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
      {people.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-muted">Chi c&apos;è in copertina? Tocca nell&apos;ordine: il primo è il protagonista. Nessuno = dal titolo del video.</p>
          <div className="flex flex-wrap gap-1.5">
            {people.map((p) => {
              const index = chosen.indexOf(p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setChosen((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : prev.length < 4 ? [...prev, p] : prev))}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                    index >= 0 ? "bg-brand-400 text-on-brand" : "bg-raised text-muted hover:bg-overlay hover:text-ink"
                  }`}
                >
                  {index >= 0 && <span className="flex h-4 w-4 items-center justify-center rounded-full bg-on-brand text-[10px] text-brand-300">{index + 1}</span>}
                  {p}
                </button>
              );
            })}
          </div>
        </div>
      )}
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

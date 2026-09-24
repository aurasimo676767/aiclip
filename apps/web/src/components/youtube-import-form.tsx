"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Link2, Loader2 } from "lucide-react";

export function YoutubeImportForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/projects/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Importazione fallita");
      }
      router.push(`/dashboard/projects/${data.projectId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex flex-col gap-2 rounded-2xl border border-line-strong bg-canvas p-2 transition focus-within:border-brand-400 focus-within:ring-4 focus-within:ring-brand-500/15 sm:flex-row sm:items-center">
        <div className="flex flex-1 items-center gap-3 px-3">
          <Link2 size={18} className="shrink-0 text-faint" />
          <input
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Incolla un link YouTube…"
            className="w-full bg-transparent py-2.5 text-[15px] text-ink placeholder:text-faint focus:outline-none"
          />
        </div>
        <button type="submit" disabled={loading || url.trim().length === 0} className="btn btn-gradient btn-lg">
          {loading ? <Loader2 size={18} className="animate-spin" /> : <ArrowRight size={18} />}
          {loading ? "Importo…" : "Crea clip"}
        </button>
      </div>
      {error && <p className="px-2 text-sm text-red-400">{error}</p>}
    </form>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function BulkYoutubeImportForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const urls = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (urls.length === 0) {
      setError("Incolla almeno un link YouTube (uno per riga)");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/projects/youtube/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Importazione fallita");
      if (data.projectIds.length === 0) {
        throw new Error(data.errors?.[0]?.error ?? "Nessun link valido");
      }
      router.push(`/dashboard/batch?ids=${data.projectIds.join(",")}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <textarea
        required
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Un link YouTube per riga, es.:\nhttps://www.youtube.com/watch?v=...\nhttps://youtu.be/..."}
        className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-white outline-none focus:border-brand-400"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="rounded-lg bg-brand-500 px-6 py-3 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
      >
        {loading ? "Importazione..." : "Genera più video"}
      </button>
    </form>
  );
}

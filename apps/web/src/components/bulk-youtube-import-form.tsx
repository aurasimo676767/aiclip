"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Layers, Loader2 } from "lucide-react";

export function BulkYoutubeImportForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urls = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (urls.length === 0) {
      setError("Incolla almeno un link YouTube (uno per riga)");
      return;
    }

    setLoading(true);
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
        placeholder={"Un link YouTube per riga\nhttps://www.youtube.com/watch?v=…\nhttps://youtu.be/…"}
        className="input resize-y rounded-2xl px-4 py-3 text-[15px]"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint">Tutte le clip suggerite vengono messe subito in render, senza selezione manuale.</p>
        <button type="submit" disabled={loading || urls.length === 0} className="btn btn-gradient">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Layers size={16} />}
          {loading ? "Importo…" : urls.length > 1 ? `Genera ${urls.length} video` : "Genera"}
        </button>
      </div>
    </form>
  );
}

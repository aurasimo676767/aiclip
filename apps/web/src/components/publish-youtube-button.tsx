"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface PublishYoutubeButtonProps {
  clipId: string;
  defaultTitle: string;
  defaultDescription: string;
  defaultHashtags: string[];
  status: string | null;
  youtubeUrl: string | null;
  youtubeError: string | null;
}

export function PublishYoutubeButton({
  clipId,
  defaultTitle,
  defaultDescription,
  defaultHashtags,
  status,
  youtubeUrl,
  youtubeError,
}: PublishYoutubeButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle.slice(0, 100));
  const [description, setDescription] = useState(defaultDescription);
  const [hashtags, setHashtags] = useState(defaultHashtags.join(" "));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === "COMPLETED" && youtubeUrl) {
    return (
      <a
        href={youtubeUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs font-medium text-emerald-400 hover:underline"
      >
        Pubblicato su YouTube ↗
      </a>
    );
  }

  if (status === "PENDING" || status === "UPLOADING") {
    return <span className="text-xs text-amber-300">Pubblicazione su YouTube in corso...</span>;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const tags = hashtags
        .split(/[\s,]+/)
        .map((t) => t.replace(/^#/, "").trim())
        .filter(Boolean);

      const res = await fetch(`/api/clips/${clipId}/publish-youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, tags, privacyStatus: "public" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Pubblicazione fallita");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <div className="space-y-1">
        {status === "FAILED" && youtubeError && <p className="text-xs text-red-400">Pubblicazione fallita: {youtubeError}</p>}
        <button
          onClick={() => setOpen(true)}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500"
        >
          Pubblica su YouTube
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 max-w-md space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <div>
        <label className="mb-1 block text-xs text-zinc-500">Titolo ({title.length}/100)</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, 100))}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-white outline-none focus:border-brand-400"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-zinc-500">Descrizione</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-white outline-none focus:border-brand-400"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-zinc-500">Hashtag (separati da spazio)</label>
        <input
          value={hashtags}
          onChange={(e) => setHashtags(e.target.value)}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-white outline-none focus:border-brand-400"
        />
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {submitting ? "Pubblicazione..." : "Conferma e pubblica"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500"
        >
          Annulla
        </button>
      </div>
    </form>
  );
}

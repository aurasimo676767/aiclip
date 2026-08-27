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
  youtubePublishAt: string | null;
  youtubeCancelledAt: string | null;
}

export function PublishYoutubeButton({
  clipId,
  defaultTitle,
  defaultDescription,
  defaultHashtags,
  status,
  youtubeUrl,
  youtubeError,
  youtubePublishAt,
  youtubeCancelledAt,
}: PublishYoutubeButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle.slice(0, 100));
  const [description, setDescription] = useState(defaultDescription);
  const [hashtags, setHashtags] = useState(defaultHashtags.join(" "));
  const [scheduledAt, setScheduledAt] = useState(""); // valore di <input type="datetime-local">, vuoto = nessuna programmazione
  const [submitting, setSubmitting] = useState<"now" | "scheduled" | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancelSchedule() {
    if (!window.confirm("Annullare la programmazione? Il video resterà caricato ma privato su YouTube.")) return;
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/cancel-schedule`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Annullamento fallito");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setCancelling(false);
    }
  }

  if (status === "COMPLETED" && youtubeUrl) {
    if (youtubeCancelledAt) {
      return (
        <div className="space-y-0.5">
          <a href={youtubeUrl} target="_blank" rel="noreferrer" className="inline-block text-xs font-medium text-zinc-400 hover:underline">
            Programmazione annullata — video privato ↗
          </a>
        </div>
      );
    }

    const scheduledInFuture = youtubePublishAt && new Date(youtubePublishAt).getTime() > Date.now();
    return (
      <div className="space-y-1">
        <a href={youtubeUrl} target="_blank" rel="noreferrer" className="inline-block text-xs font-medium text-emerald-400 hover:underline">
          {scheduledInFuture ? "Caricato, in attesa di pubblicazione ↗" : "Pubblicato su YouTube ↗"}
        </a>
        {scheduledInFuture && (
          <>
            <p className="text-xs text-zinc-500">
              Diventerà pubblico il{" "}
              {new Date(youtubePublishAt).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" })}
            </p>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              onClick={cancelSchedule}
              disabled={cancelling}
              className="rounded-lg border border-red-400/40 px-3 py-1 text-xs font-medium text-red-200 hover:border-red-400 disabled:opacity-50"
            >
              {cancelling ? "Annullo..." : "Annulla programmazione"}
            </button>
          </>
        )}
      </div>
    );
  }

  if (status === "PENDING" || status === "UPLOADING") {
    return <span className="text-xs text-amber-300">Pubblicazione su YouTube in corso...</span>;
  }

  async function submit(mode: "now" | "scheduled") {
    setSubmitting(mode);
    setError(null);
    try {
      const tags = hashtags
        .split(/[\s,]+/)
        .map((t) => t.replace(/^#/, "").trim())
        .filter(Boolean);

      // <input type="datetime-local"> non ha timezone: interpretato come ora LOCALE del
      // browser da `new Date(...)`, poi convertito in UTC da toISOString() per l'API.
      const publishAt = mode === "scheduled" && scheduledAt ? new Date(scheduledAt).toISOString() : null;

      const res = await fetch(`/api/clips/${clipId}/publish-youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, tags, privacyStatus: "public", publishAt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Pubblicazione fallita");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSubmitting(null);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit("now");
  }

  // Minimo 2 minuti nel futuro (coerente col margine controllato dal server) per evitare che
  // l'orologio del browser sia leggermente indietro rispetto a quello del server.
  const minScheduledAt = new Date(Date.now() + 2 * 60 * 1000).toISOString().slice(0, 16);

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

      <div>
        <label className="mb-1 block text-xs text-zinc-500">Programma per (opzionale — lascia vuoto per pubblicare subito)</label>
        <input
          type="datetime-local"
          value={scheduledAt}
          min={minScheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-white outline-none focus:border-brand-400 [color-scheme:dark]"
        />
        <p className="mt-1 text-xs text-zinc-600">
          Il file viene caricato subito (serve il worker acceso ora), ma resta privato — è YouTube a renderlo pubblico da sola
          all&apos;orario scelto. Dopo l&apos;upload puoi spegnere tutto.
        </p>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="submit"
          disabled={submitting !== null}
          className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {submitting === "now" ? "Pubblicazione..." : "Pubblica subito"}
        </button>
        <button
          type="button"
          disabled={submitting !== null || !scheduledAt}
          onClick={() => submit("scheduled")}
          className="rounded-lg border border-brand-400 px-3 py-1.5 text-xs font-medium text-brand-200 hover:bg-brand-500/10 disabled:opacity-50"
          title={!scheduledAt ? "Scegli prima data e ora sopra" : undefined}
        >
          {submitting === "scheduled" ? "Programmazione..." : "Programma"}
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

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, ExternalLink, Loader2, Send } from "lucide-react";
import { useConfirm } from "./ui-kit/confirm";

interface PublishStatusProps {
  clipId: string;
  status: string | null;
  youtubeUrl: string | null;
  youtubeError: string | null;
  youtubePublishAt: string | null;
  youtubeCancelledAt: string | null;
}

/**
 * Stato della pubblicazione YouTube di una clip (online, programmata, in corso, fallita).
 * Ritorna null se la clip non è mai stata pubblicata: in quel caso si mostra il pulsante per aprire PublishPanel.
 */
export function PublishStatus({ clipId, status, youtubeUrl, youtubeError, youtubePublishAt, youtubeCancelledAt }: PublishStatusProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancelSchedule() {
    const ok = await confirm({
      title: "Annullare la programmazione?",
      description: "Il video resterà caricato su YouTube, ma privato.",
      confirmLabel: "Annulla programmazione",
      destructive: true,
    });
    if (!ok) return;
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
    const scheduledInFuture = youtubePublishAt && new Date(youtubePublishAt).getTime() > Date.now();
    return (
      <div className="space-y-2 rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-3">
        <a href={youtubeUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-300 hover:underline">
          {scheduledInFuture ? "Caricato, in attesa di pubblicazione" : "Pubblicato su YouTube"} <ExternalLink size={13} />
        </a>
        {scheduledInFuture && (
          <>
            <p className="text-xs text-muted">
              Diventa pubblico il {new Date(youtubePublishAt).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" })}
            </p>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button onClick={cancelSchedule} disabled={cancelling} className="btn btn-danger btn-sm">
              {cancelling ? "Annullo…" : "Annulla programmazione"}
            </button>
          </>
        )}
        {confirm.element}
      </div>
    );
  }

  if (status === "PENDING" || status === "UPLOADING") {
    return (
      <p className="inline-flex items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-sm text-amber-200">
        <Loader2 size={14} className="animate-spin" /> Caricamento su YouTube in corso…
      </p>
    );
  }

  if ((status === "FAILED" && youtubeError) || (youtubeCancelledAt && !youtubeUrl)) {
    return (
      <p className="rounded-xl border border-line bg-raised px-3 py-2 text-xs text-muted">
        {status === "FAILED" && youtubeError ? <span className="text-red-300">Pubblicazione fallita: {youtubeError}</span> : "Programmazione precedente annullata (video eliminato da YouTube)."}
      </p>
    );
  }

  return null;
}

interface PublishPanelProps {
  clipId: string;
  defaultTitle: string;
  defaultDescription: string;
  defaultHashtags: string[];
  onDone: () => void;
  onCancel: () => void;
}

export function PublishPanel({ clipId, defaultTitle, defaultDescription, defaultHashtags, onDone, onCancel }: PublishPanelProps) {
  const router = useRouter();
  const [title, setTitle] = useState(defaultTitle.slice(0, 100));
  const [description, setDescription] = useState(defaultDescription);
  const [hashtags, setHashtags] = useState(defaultHashtags.join(" "));
  const [scheduledAt, setScheduledAt] = useState(""); // valore di <input type="datetime-local">, vuoto = nessuna programmazione
  const [submitting, setSubmitting] = useState<"now" | "scheduled" | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      router.refresh();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSubmitting(null);
    }
  }

  // Minimo 2 minuti nel futuro (coerente col margine controllato dal server) per evitare che
  // l'orologio del browser sia leggermente indietro rispetto a quello del server.
  const minScheduledAt = new Date(Date.now() + 2 * 60 * 1000).toISOString().slice(0, 16);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit("now");
      }}
      className="space-y-4"
    >
      <p className="section-title">Pubblica su YouTube</p>
      <div>
        <label className="label">
          Titolo <span className="text-faint">({title.length}/100)</span>
        </label>
        <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 100))} className="input" />
      </div>
      <div>
        <label className="label">Descrizione</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="input" />
      </div>
      <div>
        <label className="label">Hashtag</label>
        <input value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="blur reaction gtavi" className="input" />
      </div>
      <div>
        <label className="label">Programma per (facoltativo)</label>
        <input type="datetime-local" value={scheduledAt} min={minScheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="input [color-scheme:dark]" />
        <p className="mt-1.5 text-xs text-faint">
          Il file si carica subito (serve il worker acceso adesso) e resta privato: è YouTube a renderlo pubblico all&apos;orario scelto.
        </p>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {scheduledAt ? (
          <button type="button" disabled={submitting !== null} onClick={() => submit("scheduled")} className="btn btn-primary btn-sm">
            {submitting === "scheduled" ? <Loader2 size={14} className="animate-spin" /> : <CalendarClock size={14} />}
            Programma
          </button>
        ) : (
          <button type="submit" disabled={submitting !== null || title.trim().length === 0} className="btn btn-primary btn-sm">
            {submitting === "now" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Pubblica subito
          </button>
        )}
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">
          Indietro
        </button>
      </div>
    </form>
  );
}

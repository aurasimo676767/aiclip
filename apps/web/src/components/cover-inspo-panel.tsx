"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Check, Loader2, Plus, X } from "lucide-react";

interface Channel {
  url: string;
  name?: string;
}

interface TopCover {
  videoId: string;
  channel: string;
  title: string;
  views: number | null;
  outlier: number | null;
  approved: boolean;
  text: string | null;
  hook: string;
  url: string;
}

interface InspoState {
  channels: Channel[];
  saved: boolean;
  trainRequestedAt: string | null;
  lastTrainedAt: string | null;
  training: { done: number; total: number; step: string } | null;
  lastError: string | null;
  lastSummary: string | null;
  counts: { total: number; approved: number };
  top: TopCover[];
}

const formatViews = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} mln` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * Allenamento delle copertine: i canali da seguire, il pulsante "Allena adesso" e le copertine che
 * hanno funzionato di più (quelle da cui l'AI impara). Il lavoro lo fa il worker
 * (apps/worker/src/pipeline/cover-inspo-train.ts), che guarda la richiesta ogni 2 minuti.
 */
export function CoverInspoPanel() {
  const [state, setState] = useState<InspoState | null>(null);
  const [newChannel, setNewChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/cover-inspo");
    const data = await res.json().catch(() => null);
    if (res.ok && data) setState(data as InspoState);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const waiting = Boolean(state && state.trainRequestedAt && (!state.lastTrainedAt || state.trainRequestedAt > state.lastTrainedAt));
  const working = Boolean(state?.training) || waiting;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [working, load]);

  async function save(body: { channels?: Channel[]; train?: boolean }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/cover-inspo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Salvataggio non riuscito");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setBusy(false);
    }
  }

  function addChannel(e: React.FormEvent) {
    e.preventDefault();
    const url = newChannel.trim();
    if (!url || !state) return;
    setNewChannel("");
    void save({ channels: [...state.channels, { url }] });
  }

  if (!state) {
    return (
      <section className="rounded-lg border border-line bg-surface p-4">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Carico l&apos;allenamento…
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <Brain size={18} className="text-brand-300" /> Allenamento copertine
          </h2>
          <p className="mt-1 max-w-prose text-sm text-muted">
            L&apos;AI studia le copertine dei canali che segui e guarda quali fanno più visualizzazioni del solito. Ogni copertina
            nuova parte da quelle più simili che hanno funzionato. Imparano anche dalle copertine che approvi con &quot;Carica&quot;.
          </p>
        </div>
        <button onClick={() => void save({ train: true })} disabled={busy || working || state.channels.length === 0} className="btn btn-primary btn-sm shrink-0">
          {working ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}
          {working ? "Si allena…" : "Allena adesso"}
        </button>
      </div>

      {working && (
        <p className="text-xs text-muted">
          {state.training
            ? `${state.training.step}: ${state.training.done} di ${state.training.total}`
            : "Richiesta mandata: il PC la prende entro 2 minuti (deve essere acceso)."}
        </p>
      )}
      {!working && state.lastSummary && (
        <p className="flex items-center gap-1.5 text-xs text-brand-300">
          <Check size={14} /> {state.lastSummary}
          {state.lastTrainedAt ? ` · ${new Date(state.lastTrainedAt).toLocaleDateString("it-IT", { day: "numeric", month: "short" })}` : ""}
        </p>
      )}
      {state.lastError && <p className="text-xs text-red-300">{state.lastError}</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-faint">Canali seguiti{state.saved ? "" : " (proposti)"}</p>
        <ul className="flex flex-wrap gap-1.5">
          {state.channels.map((c) => (
            <li key={c.url} className="inline-flex max-w-full items-center gap-1 rounded-lg bg-canvas py-1 pl-2.5 pr-1 text-xs text-ink">
              <span className="truncate">{c.name || c.url.replace(/^https?:\/\/(www\.)?youtube\.com\//, "")}</span>
              <button
                type="button"
                aria-label={`Togli ${c.name || c.url}`}
                disabled={busy}
                onClick={() => void save({ channels: state.channels.filter((x) => x.url !== c.url) })}
                className="rounded p-0.5 text-faint transition hover:bg-overlay hover:text-ink"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={addChannel} className="flex gap-2">
          <input
            value={newChannel}
            onChange={(e) => setNewChannel(e.target.value)}
            placeholder="Link o @nome di un canale YouTube"
            className="input min-w-0 flex-1 text-sm"
          />
          <button type="submit" disabled={busy || !newChannel.trim()} className="btn btn-secondary btn-sm shrink-0">
            <Plus size={14} /> Aggiungi
          </button>
        </form>
        <p className="text-xs text-faint">
          Si guardano gli ultimi 60 video di ogni canale. Dopo il primo allenamento si riguardano da soli una volta a settimana. Costa
          circa 1 centesimo ogni 30 copertine nuove.
        </p>
      </div>

      {state.top.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-faint">
            Cosa ha imparato · {state.counts.total} copertine{state.counts.approved ? `, ${state.counts.approved} approvate da te` : ""}
          </p>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {state.top.map((c) => (
              <li key={c.videoId} className="min-w-0 space-y-1">
                <img src={c.url} alt={c.text ? `Copertina con la scritta ${c.text}` : c.title} loading="lazy" className="aspect-video w-full rounded-md border border-line object-cover" />
                <p className="truncate text-xs font-semibold text-ink" title={c.title}>
                  {c.approved ? "Approvata da te" : c.outlier ? `${c.outlier.toFixed(1)}× il solito` : "Recente"}
                  {c.views ? <span className="font-normal text-faint"> · {formatViews(c.views)} view</span> : null}
                </p>
                <p className="truncate text-xs text-muted">{c.channel}</p>
                {c.hook && <p className="line-clamp-2 text-xs text-faint">{c.hook}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

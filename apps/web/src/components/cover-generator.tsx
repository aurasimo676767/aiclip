"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Image as ImageIcon, Loader2, RefreshCw, Upload } from "lucide-react";

interface CoverJob {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  error: string | null;
  url: string | null;
  applyRequested: boolean;
  youtubeSet: boolean;
}

/**
 * Pulsante "Genera copertina" nel dettaglio di un video (long-form 16:9 e Shorts 9:16): genera
 * un'anteprima con GPT Image, poi "Carica" la manda su YouTube (subito se il video è già
 * pubblicato, alla pubblicazione altrimenti) e "Rigenera" ne fa un'altra. Circa 5 centesimi a
 * copertina, quindi si genera solo quando lo si preme.
 */
export function CoverGenerator({ clipId, isShort }: { clipId: string; isShort: boolean }) {
  const [job, setJob] = useState<CoverJob | null>(null);
  const [people, setPeople] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/clips/${clipId}/cover`);
    const data = await res.json().catch(() => ({}));
    if (res.ok) setJob(data.job ?? null);
  }, [clipId]);

  useEffect(() => {
    void load();
    fetch("/api/faces")
      .then((r) => r.json())
      .then((d) => setPeople(d.people ?? []))
      .catch(() => undefined);
  }, [load]);

  const working = job?.status === "PENDING" || job?.status === "PROCESSING";
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [working, load]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/cover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ people: chosen.length ? chosen : undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Avvio fallito");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/thumbnails/${job.id}/apply`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Caricamento fallito");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setBusy(false);
    }
  }

  const ready = job?.status === "COMPLETED" && job.url;
  const applied = ready && job.applyRequested;

  return (
    <div className="space-y-3 rounded-xl border border-line bg-raised/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">Copertina</p>
        {!working && (
          <button onClick={generate} disabled={busy} className="btn btn-secondary btn-sm">
            {busy && !job?.applyRequested ? <Loader2 size={14} className="animate-spin" /> : job ? <RefreshCw size={14} /> : <ImageIcon size={14} />}
            {job ? "Rigenera" : "Genera copertina"}
          </button>
        )}
      </div>

      {people.length > 0 && !working && (
        <div>
          <p className="mb-1.5 text-xs text-muted">Chi c&apos;è? Tocca nell&apos;ordine, il primo è il protagonista. Nessuno = dal titolo.</p>
          <div className="flex flex-wrap gap-1.5">
            {people.map((p) => {
              const index = chosen.indexOf(p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setChosen((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : prev.length < 4 ? [...prev, p] : prev))}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold transition ${
                    index >= 0 ? "bg-brand-400 text-on-brand" : "bg-canvas text-muted hover:bg-overlay hover:text-ink"
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

      {working && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Loader2 size={14} className="animate-spin text-brand-300" />
          {job?.applyRequested ? "Carico la copertina…" : "Genero la copertina… (circa mezzo minuto)"}
        </p>
      )}

      {job?.status === "FAILED" && <p className="text-xs text-red-300">Non riuscita: {job.error ?? "errore sconosciuto"}. Premi Rigenera.</p>}

      {ready && (
        <div className="space-y-2">
          <img
            src={job.url!}
            alt="Anteprima della copertina"
            className={`rounded-lg border border-line ${isShort ? "aspect-[9/16] w-40" : "aspect-video w-full max-w-sm"} object-cover`}
          />
          {applied ? (
            <p className="flex items-center gap-1.5 text-xs text-emerald-300">
              <Check size={14} />
              {job.youtubeSet ? "Caricata su YouTube." : "Approvata: verrà messa sul video appena lo pubblichi."}
            </p>
          ) : (
            <div className="flex gap-2">
              <button onClick={apply} disabled={busy} className="btn btn-primary btn-sm">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                Carica
              </button>
              <a href={job.url!} download className="btn btn-ghost btn-sm">
                Scarica
              </a>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}

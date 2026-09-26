"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Image as ImageIcon, Loader2, RefreshCw, Upload } from "lucide-react";

interface CoverJob {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  error: string | null;
  url: string | null;
  applyRequested: boolean;
  youtubeSet: boolean;
  youtubeVideoId: string | null;
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
  const [text, setText] = useState("");
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
        body: JSON.stringify({ people: chosen.length ? chosen : undefined, text: text.trim() || undefined }),
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

      {!working && (
        <input
          value={text}
          maxLength={40}
          onChange={(e) => setText(e.target.value)}
          placeholder="Scritta (facoltativa, se no la sceglie l'AI)"
          className="input text-sm"
        />
      )}

      {working && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Loader2 size={14} className="animate-spin text-brand-300" />
          {job?.applyRequested ? "Carico la copertina…" : "Genero la copertina… (circa mezzo minuto)"}
        </p>
      )}

      {job?.status === "FAILED" && (
        <p className="text-xs text-red-300">
          {job.error?.includes("safety")
            ? "OpenAI ha rifiutato l'argomento (i suoi filtri bloccano temi come simboli d'odio o sesso). Prova con una scritta diversa; se il tema si vede nel video potrebbe non riuscire comunque."
            : `Non riuscita: ${job.error ?? "errore sconosciuto"}. Premi Rigenera.`}
        </p>
      )}

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

      {ready && isShort && (
        <div className="space-y-1.5 border-t border-line pt-3">
          <p className="text-xs leading-relaxed text-muted">
            Nella scheda Shorts del canale YouTube mostra la copertina verticale solo se la carichi a mano da Studio (dall&apos;API non si può).
          </p>
          {job.youtubeVideoId ? (
            <a
              href={`/api/thumbnails/${job.id}/download`}
              download
              onClick={() => window.open(`https://studio.youtube.com/video/${job.youtubeVideoId}/edit`, "_blank", "noopener")}
              className="btn btn-secondary btn-sm"
            >
              <ExternalLink size={14} /> Scarica e apri Studio
            </a>
          ) : (
            <p className="text-xs text-faint">Quando lo Short è pubblicato qui compare il pulsante per aprirlo su Studio.</p>
          )}
          <p className="text-xs text-faint">Su Studio: Miniatura → Carica miniatura → scegli il file appena scaricato → Salva.</p>
        </div>
      )}

      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}

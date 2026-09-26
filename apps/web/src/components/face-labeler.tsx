"use client";

import { useMemo, useState } from "react";
import { Check, Loader2, Trash2, UserRound } from "lucide-react";
import { EmptyState } from "./ui";

export interface FaceCardData {
  id: string;
  url: string;
  label: string | null;
  expression: string;
  intensity: number;
}

const EXPRESSIONS: Record<string, string> = {
  shock: "Stupore",
  urlo: "Urlo",
  risata: "Risata",
  rabbia: "Rabbia",
  paura: "Paura",
  mani_in_testa: "Mani in testa",
  sospetto: "Sospetto",
  sorriso: "Sorriso",
  neutra: "Neutra",
};

type Filter = "todo" | "named";

/** Griglia per dare un nome alle facce della libreria copertine, pensata per il telefono. */
export function FaceLabeler({ faces: initial, names }: { faces: FaceCardData[]; names: string[] }) {
  const [faces, setFaces] = useState(initial);
  const [filter, setFilter] = useState<Filter>("todo");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const todo = faces.filter((f) => !f.label);
  const named = faces.filter((f) => f.label);
  const shown = filter === "todo" ? todo : named;
  const countsByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of named) m.set(f.label!, (m.get(f.label!) ?? 0) + 1);
    return m;
  }, [named]);

  async function save(id: string, body: { label?: string | null; reject?: boolean }) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/faces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...body }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Salvataggio non riuscito");
      setFaces((prev) => (body.reject ? prev.filter((f) => f.id !== id) : prev.map((f) => (f.id === id ? { ...f, label: body.label ?? null } : f))));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Salvataggio non riuscito");
    } finally {
      setBusy(null);
    }
  }

  if (faces.length === 0) {
    return <EmptyState icon={<UserRound size={20} />} title="Nessuna faccia ancora" description="Le facce raccolte dalle copertine dei canali compariranno qui." />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["todo", `Da nominare ${todo.length}`],
            ["named", `Con nome ${named.length}`],
          ] as const
        ).map(([id, text]) => (
          <button
            key={id}
            onClick={() => setFilter(id)}
            className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
              filter === id ? "border-brand-400/60 bg-brand-400/15 text-brand-100" : "border-line bg-raised text-muted hover:text-ink"
            }`}
          >
            {text}
          </button>
        ))}
        {named.length > 0 && (
          <p className="text-xs text-faint">
            {[...countsByName.entries()].map(([n, c]) => `${n} ${c}`).join(" · ")}
          </p>
        )}
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}

      {shown.length === 0 ? (
        <EmptyState
          icon={<Check size={20} />}
          title={filter === "todo" ? "Hai nominato tutte le facce" : "Nessuna faccia con un nome"}
          description={filter === "todo" ? "Le copertine useranno quelle con un nome." : "Tocca un nome sotto una faccia per assegnarlo."}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {shown.map((face) => (
            <FaceCard key={face.id} face={face} names={names} busy={busy === face.id} onSave={(body) => save(face.id, body)} />
          ))}
        </div>
      )}
    </div>
  );
}

function FaceCard({
  face,
  names,
  busy,
  onSave,
}: {
  face: FaceCardData;
  names: string[];
  busy: boolean;
  onSave: (body: { label?: string | null; reject?: boolean }) => void;
}) {
  const [custom, setCustom] = useState("");
  return (
    <div className={`flex flex-col overflow-hidden rounded-xl border bg-surface ${face.label ? "border-brand-400/50" : "border-line"}`}>
      <div className="relative aspect-square bg-[radial-gradient(circle_at_50%_40%,#3a3446,#15121c)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={face.url} alt="" loading="lazy" className="h-full w-full object-contain" />
        <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">
          {EXPRESSIONS[face.expression] ?? face.expression}
        </span>
        {face.label && <span className="absolute bottom-2 left-2 rounded-md bg-brand-400 px-2 py-0.5 text-xs font-bold text-on-brand">{face.label}</span>}
        {busy && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/50">
            <Loader2 size={22} className="animate-spin text-white" />
          </span>
        )}
      </div>
      <div className="space-y-2 p-2">
        <div className="flex flex-wrap gap-1">
          {names.map((n) => (
            <button
              key={n}
              disabled={busy}
              onClick={() => onSave({ label: face.label === n ? null : n })}
              className={`rounded-md px-2 py-1 text-xs font-semibold transition ${
                face.label === n ? "bg-brand-400 text-on-brand" : "bg-raised text-muted hover:bg-overlay hover:text-ink"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (custom.trim()) onSave({ label: custom.trim().toUpperCase() });
            setCustom("");
          }}
          className="flex gap-1"
        >
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Altro nome" className="input h-8 px-2 py-1 text-xs" />
        </form>
        <button
          disabled={busy}
          onClick={() => onSave({ reject: true })}
          className="flex w-full items-center justify-center gap-1 rounded-md py-1 text-xs text-faint transition hover:bg-hot/10 hover:text-red-200"
        >
          <Trash2 size={12} /> Scarta
        </button>
      </div>
    </div>
  );
}

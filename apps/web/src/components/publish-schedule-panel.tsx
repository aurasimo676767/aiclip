"use client";

import { useState } from "react";
import { PUBLISH_SCHEDULE_TIMEZONE, isValidTimeString } from "@/lib/publish-schedule";

interface TimeListEditorProps {
  label: string;
  times: string[];
  onChange: (times: string[]) => void;
}

function TimeListEditor({ label, times, onChange }: TimeListEditorProps) {
  const [input, setInput] = useState("");

  function handleAdd() {
    if (!isValidTimeString(input) || times.includes(input)) return;
    onChange([...times, input].sort());
    setInput("");
  }

  function handleRemove(t: string) {
    onChange(times.filter((x) => x !== t));
  }

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-zinc-400">{label}</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {times.length === 0 && <span className="text-xs text-zinc-600">Nessun orario — usa il fallback 2h-2h30 random</span>}
        {times.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200">
            {t}
            <button onClick={() => handleRemove(t)} className="text-zinc-500 hover:text-red-400" aria-label={`Rimuovi ${t}`}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="time"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-white outline-none focus:border-brand-400"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={!isValidTimeString(input) || times.includes(input)}
          className="rounded-lg border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
        >
          Aggiungi
        </button>
      </div>
    </div>
  );
}

export function PublishSchedulePanel({
  initialShortTimes,
  initialLongformTimes,
}: {
  initialShortTimes: string[];
  initialLongformTimes: string[];
}) {
  const [shortTimes, setShortTimes] = useState(initialShortTimes);
  const [longformTimes, setLongformTimes] = useState(initialLongformTimes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/publish-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortTimes, longformTimes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Salvataggio fallito");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">
        Orari fissi ({PUBLISH_SCHEDULE_TIMEZONE}) usati quando programmi più clip insieme: ogni clip prende il prossimo orario
        libero nella griglia del suo formato, ripetuta ogni giorno. Se lasci un formato senza orari, per quel formato resta il
        vecchio comportamento (2h-2h30 casuali da adesso).
      </p>

      <TimeListEditor label="Shorts" times={shortTimes} onChange={setShortTimes} />
      <TimeListEditor label="Video long-form" times={longformTimes} onChange={setLongformTimes} />

      <div className="flex items-center gap-3 border-t border-zinc-800 pt-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {saving ? "Salvo..." : "Salva orari"}
        </button>
        {saved && <span className="text-xs text-emerald-400">Salvato.</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}

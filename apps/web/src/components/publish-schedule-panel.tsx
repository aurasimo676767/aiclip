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
      <p className="label">{label}</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {times.length === 0 && <span className="text-xs text-faint">Nessun orario: ogni clip esce 2h-2h30 dopo la precedente</span>}
        {times.map((t) => (
          <span key={t} className="chip gap-1.5 text-ink tabular-nums">
            {t}
            <button onClick={() => handleRemove(t)} className="text-faint hover:text-red-300" aria-label={`Rimuovi ${t}`}>
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
          className="input w-32 [color-scheme:dark]"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={!isValidTimeString(input) || times.includes(input)}
          className="btn btn-secondary btn-sm"
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
      <p className="text-xs leading-relaxed text-muted">
        Orari fissi ({PUBLISH_SCHEDULE_TIMEZONE}) usati quando programmi più clip insieme: ogni clip prende il prossimo orario
        libero nella griglia del suo formato, ripetuta ogni giorno. Se lasci un formato senza orari, per quel formato resta il
        vecchio comportamento (2h-2h30 casuali da adesso).
      </p>

      <TimeListEditor label="Shorts" times={shortTimes} onChange={setShortTimes} />
      <TimeListEditor label="Video long-form" times={longformTimes} onChange={setLongformTimes} />

      <div className="flex items-center gap-3 border-t border-line pt-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn btn-primary btn-sm"
        >
          {saving ? "Salvo…" : "Salva orari"}
        </button>
        {saved && <span className="text-xs text-emerald-400">Salvato.</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface FollowedTwitchChannel {
  id: string;
  displayName: string;
}

export function FollowedTwitchChannelsPanel({ channels }: { channels: FollowedTwitchChannel[] }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/twitch-channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Aggiunta canale fallita");
      setInput("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/twitch-channels/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Rimozione fallita");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="twitch.tv/nomecanale"
          className="input min-w-0 flex-1"
        />
        <button
          type="submit"
          disabled={adding || !input.trim()}
          className="btn btn-secondary shrink-0"
        >
          {adding ? "Aggiungo..." : "Aggiungi"}
        </button>
      </form>

      {channels.length > 0 ? (
        <ul className="space-y-1.5">
          {channels.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-lg border border-line bg-raised/60 px-3 py-2 text-sm text-ink">
              {c.displayName}
              <button onClick={() => handleRemove(c.id)} className="text-xs text-faint transition hover:text-red-300">
                Rimuovi
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-faint">Non segui ancora nessun canale Twitch.</p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

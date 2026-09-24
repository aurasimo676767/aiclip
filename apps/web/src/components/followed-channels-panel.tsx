"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface FollowedChannel {
  id: string;
  channelTitle: string;
}

interface ScanResult {
  channelsScanned: number;
  newVideosFound: number;
  imported: string[];
}

export function FollowedChannelsPanel({ channels }: { channels: FollowedChannel[] }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/channels", {
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
      const res = await fetch(`/api/channels/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Rimozione fallita");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    }
  }

  async function handleScan() {
    setScanning(true);
    setError(null);
    setScanResult(null);
    try {
      const res = await fetch("/api/channels/scan", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Scan fallito");
      setScanResult(data as ScanResult);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="youtube.com/@nomecanale"
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
              {c.channelTitle}
              <button onClick={() => handleRemove(c.id)} className="text-xs text-faint transition hover:text-red-300">
                Rimuovi
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-faint">Non segui ancora nessun canale.</p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="space-y-2 border-t border-line pt-4">
        <button
          onClick={handleScan}
          disabled={scanning || channels.length === 0}
          className="btn btn-primary btn-sm"
        >
          {scanning ? "Scansione in corso…" : "Cerca video nuovi"}
        </button>
        <p className="text-xs text-faint">
          Importa i video nuovi trovati nella pipeline normale (stessi costi di un&apos;importazione manuale, ~$0.04-0.05 a video con
          Sonnet, ~$0.08-0.17 con Opus). Max {5} importazioni per scan.
        </p>

        {scanResult && (
          <div className="rounded-lg border border-line bg-raised/60 p-3 text-xs text-muted">
            <p>
              Controllati {scanResult.channelsScanned} canali, trovati {scanResult.newVideosFound} video nuovi
              {scanResult.imported.length > 0 ? `, importati ${scanResult.imported.length}:` : "."}
            </p>
            {scanResult.imported.length > 0 && (
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {scanResult.imported.map((title) => (
                  <li key={title} className="truncate">
                    {title}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

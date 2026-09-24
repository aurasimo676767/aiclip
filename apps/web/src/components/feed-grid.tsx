"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronRight, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { EmptyState } from "./ui";

export interface FeedItem {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  /** Riga sotto il titolo (canale), può contenere un link. */
  subtitle?: ReactNode;
  /** Metadati in basso (visualizzazioni, durata, data). */
  meta: string;
  /** Etichetta sulla copertina (es. durata del VOD). */
  badge?: string;
  alreadyImported: boolean;
}

/** Griglia di video di un feed, divisa in "nuovi" e "già generati" (questi ultimi richiudibili). */
export function FeedGrid({
  items,
  generatingId,
  onGenerate,
  emptyText,
  loading,
}: {
  items: FeedItem[] | null;
  generatingId: string | null;
  onGenerate: (id: string) => void;
  emptyText: string;
  loading: boolean;
}) {
  const [showImported, setShowImported] = useState(false);

  if (loading && !items) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <div className="skeleton aspect-video" />
            <div className="skeleton h-4 w-3/4" />
            <div className="skeleton h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }
  if (!items || items.length === 0) return <EmptyState title={emptyText} />;

  const fresh = items.filter((i) => !i.alreadyImported);
  const imported = items.filter((i) => i.alreadyImported);

  return (
    <div className="space-y-6">
      {fresh.length === 0 ? (
        <EmptyState icon={<Check size={20} />} title="Tutto generato" description="Non ci sono video nuovi: li hai già trasformati tutti." />
      ) : (
        <Grid items={fresh} generatingId={generatingId} onGenerate={onGenerate} />
      )}

      {imported.length > 0 && (
        <div className="space-y-4 border-t border-line pt-4">
          <button onClick={() => setShowImported((prev) => !prev)} className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-ink">
            <ChevronRight size={14} className={`transition ${showImported ? "rotate-90" : ""}`} />
            Già generati ({imported.length})
          </button>
          {showImported && <Grid items={imported} generatingId={generatingId} onGenerate={onGenerate} />}
        </div>
      )}
    </div>
  );
}

function Grid({ items, generatingId, onGenerate }: { items: FeedItem[]; generatingId: string | null; onGenerate: (id: string) => void }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.id} className="group flex flex-col gap-3 animate-fade-in">
          <div className="relative aspect-video overflow-hidden rounded-xl border border-line bg-raised">
            {item.thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.thumbnailUrl} alt="" loading="lazy" className={`h-full w-full object-cover transition duration-300 group-hover:scale-[1.03] ${item.alreadyImported ? "opacity-50" : ""}`} />
            )}
            {item.badge && <span className="absolute bottom-2 right-2 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white">{item.badge}</span>}
            {item.alreadyImported && (
              <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-emerald-500/85 px-1.5 py-0.5 text-[11px] font-medium text-white">
                <Check size={11} /> Generato
              </span>
            )}
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h3 className="line-clamp-2 text-sm font-medium leading-snug text-ink">{item.title}</h3>
              {item.subtitle && <div className="text-xs text-muted">{item.subtitle}</div>}
              <p className="text-xs text-faint">{item.meta}</p>
            </div>
            {!item.alreadyImported && (
              <button onClick={() => onGenerate(item.id)} disabled={generatingId !== null} className="btn btn-primary btn-sm shrink-0">
                {generatingId === item.id ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                Genera
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={loading} className="btn btn-secondary btn-sm">
      <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
      {loading ? "Aggiorno…" : "Aggiorna"}
    </button>
  );
}

export function formatRelativeTime(iso: string): string {
  if (!iso) return "";
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "oggi";
  if (diffDays === 1) return "ieri";
  if (diffDays < 30) return `${diffDays} giorni fa`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} mes${diffMonths === 1 ? "e" : "i"} fa`;
  const diffYears = Math.floor(diffMonths / 12);
  return `${diffYears} ann${diffYears === 1 ? "o" : "i"} fa`;
}

export function formatVodDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes} min`;
}

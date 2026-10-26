"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Loader2, Pencil, Star, Trash2 } from "lucide-react";
import { BUILTIN_CAPTION_PRESETS, CLASSIC_CAPTION_SETTINGS, type CaptionPreset, type CaptionSettings } from "@clipforge/shared";
import { PresetDemo } from "./preset-demo";
import { useConfirm } from "../ui-kit/confirm";

const same = (a: CaptionSettings, b: CaptionSettings) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Pagina degli stili: tutti i preset con l'esempio animato, quelli personali da rinominare o
 * eliminare, e lo stile di partenza dei nuovi Shorts (una stella sul preset scelto).
 */
export function StylesManager({
  userPresets,
  defaultSettings,
  background,
  editHref,
}: {
  userPresets: CaptionPreset[];
  defaultSettings: CaptionSettings | null;
  background: string | null;
  /** Editor dell'ultimo Short pronto, dove si creano i preset nuovi (null se non ce ne sono). */
  editHref: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [presets, setPresets] = useState(userPresets);
  const [current, setCurrent] = useState<CaptionSettings>(defaultSettings ?? CLASSIC_CAPTION_SETTINGS);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  async function makeDefault(p: CaptionPreset) {
    setBusy(p.id);
    const res = await fetch("/api/caption-default", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: p.settings }) });
    if (res.ok) setCurrent(p.settings);
    setBusy(null);
    router.refresh();
  }

  async function rename(p: CaptionPreset) {
    const name = draft.trim();
    if (!name || name === p.name) return setEditing(null);
    setBusy(p.id);
    const res = await fetch(`/api/caption-presets/${p.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (res.ok) setPresets((list) => list.map((x) => (x.id === p.id ? { ...x, name } : x)));
    setBusy(null);
    setEditing(null);
  }

  async function remove(p: CaptionPreset) {
    const ok = await confirm({ title: `Eliminare "${p.name}"?`, description: "Gli Shorts già fatti con questo stile restano come sono.", confirmLabel: "Elimina", destructive: true });
    if (!ok) return;
    setBusy(p.id);
    const res = await fetch(`/api/caption-presets/${p.id}`, { method: "DELETE" });
    if (res.ok) setPresets((list) => list.filter((x) => x.id !== p.id));
    setBusy(null);
  }

  const card = (p: CaptionPreset, custom: boolean, i: number) => {
    const isDefault = same(p.settings, current);
    return (
      <li key={p.id} className="animate-fade-in" style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}>
        <div className="relative aspect-[9/16] overflow-hidden rounded-2xl ring-1 ring-white/[0.07]">
          <PresetDemo settings={p.settings} background={background} />
          {isDefault && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-brand-500 px-2 py-0.5 text-[11px] font-semibold text-white">
              <Star size={11} fill="currentColor" /> Di partenza
            </span>
          )}
        </div>
        <div className="mt-2 space-y-2 px-0.5">
          {editing === p.id ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void rename(p);
              }}
            >
              <input autoFocus className="input py-1.5" value={draft} maxLength={40} onChange={(e) => setDraft(e.target.value)} onBlur={() => void rename(p)} />
            </form>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium text-ink">{p.name}</p>
              {custom && (
                <div className="flex shrink-0 items-center">
                  <button
                    onClick={() => {
                      setEditing(p.id);
                      setDraft(p.name);
                    }}
                    className="rounded-lg p-1.5 text-faint transition-colors hover:bg-white/[0.06] hover:text-ink"
                    aria-label={`Rinomina ${p.name}`}
                  >
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => void remove(p)} className="rounded-lg p-1.5 text-faint transition-colors hover:bg-hot/10 hover:text-[#ffb3b8]" aria-label={`Elimina ${p.name}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          )}
          <button className="btn btn-secondary btn-sm w-full" disabled={isDefault || busy === p.id} onClick={() => void makeDefault(p)}>
            {busy === p.id ? <Loader2 size={13} className="animate-spin" /> : isDefault ? <Check size={13} /> : <Star size={13} />}
            {isDefault ? "Stile di partenza" : "Usa per i nuovi"}
          </button>
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-10">
      {confirm.element}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">I tuoi preset</h2>
            <p className="mt-0.5 text-sm text-muted">Si creano dall&apos;editor di uno Short: scegli lo stile, poi &quot;Salva lo stile attuale come preset&quot;.</p>
          </div>
          {editHref && (
            <Link href={editHref} className="btn btn-primary btn-sm">
              Apri l&apos;ultimo Short
            </Link>
          )}
        </div>
        {presets.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-white/[0.09] px-5 py-8 text-center text-sm text-muted">Nessun preset personale, per ora.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">{presets.map((p, i) => card(p, true, i))}</ul>
        )}
      </section>
      <section className="space-y-4">
        <h2 className="text-base font-semibold text-ink">Pronti</h2>
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">{BUILTIN_CAPTION_PRESETS.map((p, i) => card(p, false, i))}</ul>
      </section>
    </div>
  );
}

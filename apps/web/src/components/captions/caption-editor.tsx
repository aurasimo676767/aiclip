"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2, Pause, Play, Plus, Sparkles, Star, Trash2, X } from "lucide-react";
import {
  BUILTIN_CAPTION_PRESETS,
  CAPTION_FONTS,
  CLASSIC_CAPTION_SETTINGS,
  HEADLINE_STYLES,
  normalizeCaptionSettings,
  type CaptionFont,
  type CaptionPreset,
  type CaptionSettings,
  type CaptionTrack,
  type HeadlineStyle,
} from "@clipforge/shared";
import { CaptionOverlay } from "./caption-overlay";
import { PresetDemo } from "./preset-demo";
import { useElementWidth, useVideoTime } from "./use-captions-runtime";

export interface CaptionEditorProps {
  clip: { id: string; title: string; projectId: string; status: string };
  /** Anteprima senza sottotitoli + parole coi tempi; null per gli Shorts fatti prima degli stili. */
  preview: { videoUrl: string; track: CaptionTrack } | null;
  /** Video finale (con i sottotitoli già dentro): si mostra solo se manca l'anteprima. */
  finalVideoUrl: string | null;
  poster: string | null;
  initialSettings: CaptionSettings;
  userPresets: CaptionPreset[];
  defaultSettings: CaptionSettings | null;
  /** Secondo da cui parte il video (solo per le prove in /dev-preview). */
  initialTime?: number;
}

type Tab = "preset" | "testo" | "colori" | "titolo" | "altro";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "preset", label: "Preset" },
  { id: "testo", label: "Testo" },
  { id: "colori", label: "Colori" },
  { id: "titolo", label: "Titolo" },
  { id: "altro", label: "Altro" },
];

const SWATCHES = ["#FFFFFF", "#FFD400", "#3DF36C", "#FF2E2E", "#5CF2FF", "#FF4FD8", "#FF8A00", "#000000"];

const same = (a: CaptionSettings, b: CaptionSettings) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Editor dello stile dei sottotitoli di UNO Short (simo, 2026-10-26): il video senza sottotitoli suona
 * e i sottotitoli ci vengono disegnati sopra dal vivo nello stile scelto, identici a quelli che il PC
 * brucerà nel video. Preset pronti e preset personali con un nome; "Applica" rifà lo Short senza AI.
 * Pensato per il telefono: video in alto, comandi sotto a schede, azione principale in basso.
 */
export function CaptionEditor(props: CaptionEditorProps) {
  const router = useRouter();
  const [settings, setSettings] = useState<CaptionSettings>(props.initialSettings);
  const [saved, setSaved] = useState<CaptionSettings>(props.initialSettings);
  const [tab, setTab] = useState<Tab>("preset");
  const [userPresets, setUserPresets] = useState<CaptionPreset[]>(props.userPresets);
  const [applying, setApplying] = useState<"idle" | "sending" | "queued">(props.clip.status === "QUEUED" || props.clip.status === "RENDERING" ? "queued" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const dirty = !same(settings, saved);

  const update = useCallback((patch: Partial<CaptionSettings>) => setSettings((s) => ({ ...s, ...patch })), []);
  const updateHeadline = useCallback((patch: Partial<CaptionSettings["headline"]>) => setSettings((s) => ({ ...s, headline: { ...s.headline, ...patch } })), []);

  async function apply() {
    setApplying("sending");
    setError(null);
    try {
      const res = await fetch(`/api/clips/${props.clip.id}/captions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Non sono riuscito ad applicare lo stile");
      setSaved(settings);
      setApplying("queued");
      router.refresh();
    } catch (err) {
      setApplying("idle");
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    }
  }

  async function savePreset(name: string) {
    const res = await fetch("/api/caption-presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, settings }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Preset non salvato");
    setUserPresets((list) => [...list, { id: data.preset.id, name: data.preset.name, settings: normalizeCaptionSettings(data.preset.settings) }]);
  }

  async function deletePreset(id: string) {
    const res = await fetch(`/api/caption-presets/${id}`, { method: "DELETE" });
    if (res.ok) setUserPresets((list) => list.filter((p) => p.id !== id));
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center gap-3">
        <Link href={`/dashboard/projects/${props.clip.projectId}?clip=${props.clip.id}`} className="btn btn-ghost -ml-2 h-9 w-9 p-0" aria-label="Torna allo Short">
          <ArrowLeft size={18} />
        </Link>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight text-ink">Stile sottotitoli</h1>
          <p className="truncate text-xs text-muted">{props.clip.title}</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:items-start">
        <Stage {...props} settings={settings} />

        <div className="min-w-0 space-y-4">
          <TabBar tab={tab} onChange={setTab} />
          <div key={tab} className="animate-fade-in">
            {tab === "preset" && (
              <PresetsPanel
                settings={settings}
                userPresets={userPresets}
                background={props.poster}
                onPick={(s) => setSettings(s)}
                onDelete={deletePreset}
                onSaveAs={() => setNaming(true)}
              />
            )}
            {tab === "testo" && <TextPanel settings={settings} update={update} />}
            {tab === "colori" && <ColorsPanel settings={settings} update={update} />}
            {tab === "titolo" && <TitlePanel settings={settings} updateHeadline={updateHeadline} proposed={props.preview?.track.headline ?? null} />}
            {tab === "altro" && <MorePanel settings={settings} update={update} defaultSettings={props.defaultSettings} />}
          </div>
        </div>
      </div>

      {naming && <NamePresetSheet onClose={() => setNaming(false)} onSave={savePreset} />}

      {/* Barra dell'azione principale: sempre a portata di pollice, sopra la barra di navigazione. */}
      <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+76px)] z-30 mt-6 md:bottom-4">
        <div className="card flex items-center gap-3 border-white/[0.08] bg-surface/90 p-3 shadow-pop backdrop-blur-xl">
          <div className="min-w-0 flex-1 text-xs">
            {error ? (
              <p className="text-[#ffb3b8]">{error}</p>
            ) : applying === "queued" ? (
              <p className="text-muted">
                <span className="font-medium text-ink">Il PC sta applicando lo stile.</span> Ci vuole circa un minuto e mezzo, senza costi.
              </p>
            ) : dirty ? (
              <p className="text-muted">Modifiche non ancora applicate allo Short.</p>
            ) : (
              <p className="text-faint">Lo stile attuale di questo Short.</p>
            )}
          </div>
          {dirty && applying !== "sending" && (
            <button className="btn btn-ghost btn-sm" onClick={() => setSettings(saved)}>
              Annulla
            </button>
          )}
          <button className="btn btn-primary" disabled={!dirty || applying === "sending"} onClick={apply}>
            {applying === "sending" ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
            Applica
          </button>
        </div>
      </div>
    </div>
  );
}

/** Il video 9:16 con i sottotitoli dal vivo. Tocco = play/pausa, sotto la barra per scorrere. */
function Stage({ preview, finalVideoUrl, poster, settings, initialTime }: CaptionEditorProps & { settings: CaptionSettings }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [boxRef, width] = useElementWidth<HTMLDivElement>();
  const time = useVideoTime(videoRef);
  const [playing, setPlaying] = useState(false);
  const duration = preview?.track.duration ?? 0;
  const src = preview?.videoUrl ?? finalVideoUrl;

  function toggle() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  return (
    <div className="mx-auto w-full max-w-[min(380px,58vh*0.5625)] lg:sticky lg:top-6">
      <div ref={boxRef} className="relative aspect-[9/16] w-full overflow-hidden rounded-3xl bg-black shadow-pop ring-1 ring-white/[0.08]">
        {src ? (
          <video
            ref={videoRef}
            src={src}
            poster={poster ?? undefined}
            playsInline
            loop
            preload="metadata"
            className="h-full w-full object-cover"
            onLoadedMetadata={(e) => {
              if (initialTime) e.currentTarget.currentTime = initialTime;
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onClick={toggle}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted">Video non ancora pronto.</div>
        )}
        {preview && width > 0 && <CaptionOverlay track={preview.track} settings={settings} time={time} width={width} />}
        {src && (
          <button
            onClick={toggle}
            aria-label={playing ? "Pausa" : "Riproduci"}
            className={`absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md transition-[opacity,transform] duration-200 ease-out ${
              playing ? "pointer-events-none scale-90 opacity-0" : "opacity-100"
            }`}
          >
            <Play size={26} className="translate-x-0.5" fill="currentColor" />
          </button>
        )}
        {playing && (
          <button onClick={toggle} aria-label="Pausa" className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md">
            <Pause size={16} fill="currentColor" />
          </button>
        )}
      </div>
      {preview ? (
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.05}
          value={Math.min(time, duration)}
          onChange={(e) => {
            const v = videoRef.current;
            if (v) v.currentTime = Number(e.target.value);
          }}
          aria-label="Posizione nel video"
          className="mt-3 w-full accent-brand-500"
        />
      ) : (
        <p className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-xs leading-relaxed text-muted">
          Questo Short è stato fatto prima degli stili: qui vedi il video com&apos;è adesso. Gli esempi dei preset si muovono lo stesso, e dopo il primo
          &quot;Applica&quot; l&apos;anteprima dal vivo funziona anche qui.
        </p>
      )}
    </div>
  );
}

function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`);
    if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
  }, [tab]);
  return (
    <div ref={ref} role="tablist" className="segmented flex w-full">
      {thumb && <span className="segmented-thumb" style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }} />}
      {TABS.map((t) => (
        <button key={t.id} data-tab={t.id} role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => onChange(t.id)} className="segmented-item px-2 text-[13px]">
          {t.label}
        </button>
      ))}
    </div>
  );
}

function PresetsPanel({
  settings,
  userPresets,
  background,
  onPick,
  onDelete,
  onSaveAs,
}: {
  settings: CaptionSettings;
  userPresets: CaptionPreset[];
  background: string | null;
  onPick: (s: CaptionSettings) => void;
  onDelete: (id: string) => void;
  onSaveAs: () => void;
}) {
  const card = (p: CaptionPreset, custom: boolean) => {
    const active = same(p.settings, settings);
    return (
      <li key={p.id} className="w-[30%] min-w-[96px] max-w-[132px] shrink-0 snap-start">
        <button
          onClick={() => onPick(p.settings)}
          aria-pressed={active}
          className={`relative block aspect-[9/16] w-full overflow-hidden rounded-2xl ring-2 transition-[box-shadow,transform] duration-150 ease-out active:scale-[0.97] ${
            active ? "ring-brand-400" : "ring-white/[0.06] hover:ring-white/20"
          }`}
        >
          <PresetDemo settings={p.settings} background={background} />
          {active && (
            <span className="absolute right-1.5 top-1.5 flex h-5 w-5 animate-pop-check items-center justify-center rounded-full bg-brand-500 text-white">
              <Check size={12} strokeWidth={3} />
            </span>
          )}
        </button>
        <div className="mt-1.5 flex items-center justify-between gap-1 px-0.5">
          <p className={`truncate text-xs font-medium ${active ? "text-ink" : "text-muted"}`}>{p.name}</p>
          {custom && (
            <button onClick={() => onDelete(p.id)} className="rounded p-0.5 text-faint transition-colors hover:text-[#ffb3b8]" aria-label={`Elimina il preset ${p.name}`}>
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </li>
    );
  };
  return (
    <div className="space-y-5">
      {userPresets.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-faint">I tuoi preset</h3>
          <ul className="-mx-4 flex snap-x scroll-px-4 gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">{userPresets.map((p) => card(p, true))}</ul>
        </section>
      )}
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-faint">Pronti</h3>
        <ul className="-mx-4 flex snap-x scroll-px-4 gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">{BUILTIN_CAPTION_PRESETS.map((p) => card(p, false))}</ul>
      </section>
      <button onClick={onSaveAs} className="btn btn-secondary w-full sm:w-auto">
        <Plus size={16} /> Salva lo stile attuale come preset
      </button>
    </div>
  );
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-ink">{label}</p>
        {hint && <p className="text-xs tabular-nums text-faint">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="grid gap-1 rounded-xl bg-white/[0.05] p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-lg px-2 py-2 text-[13px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.97] ${
            value === o.value ? "bg-white/[0.12] text-ink shadow-card" : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string }) {
  return <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="w-full accent-brand-500" />;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className="switch">
      <span className="sr-only">{label}</span>
    </button>
  );
}

function TextPanel({ settings, update }: { settings: CaptionSettings; update: (p: Partial<CaptionSettings>) => void }) {
  return (
    <div className="space-y-6">
      <Row label="Carattere">
        <div className="grid grid-cols-4 gap-2">
          {(Object.keys(CAPTION_FONTS) as CaptionFont[]).map((f) => {
            const font = CAPTION_FONTS[f];
            const active = settings.font === f;
            return (
              <button
                key={f}
                onClick={() => update({ font: f })}
                aria-pressed={active}
                className={`flex flex-col items-center gap-1 rounded-xl border px-1 py-3 transition-[border-color,background-color,transform] duration-150 active:scale-[0.97] ${
                  active ? "border-brand-400/60 bg-brand-500/10" : "border-white/[0.07] bg-white/[0.03] hover:border-white/15"
                }`}
              >
                <span style={{ fontFamily: font.css, fontWeight: font.weight, fontSize: 22 }} className="leading-none text-ink">
                  Aa
                </span>
                <span className="text-[11px] text-muted">{font.label}</span>
              </button>
            );
          })}
        </div>
      </Row>
      <Row label="Grandezza" hint={`${settings.size}`}>
        <Slider label="Grandezza" value={settings.size} min={60} max={170} onChange={(size) => update({ size })} />
      </Row>
      <Row label="Parole a schermo">
        <Segmented
          value={settings.wordsPerLine}
          onChange={(wordsPerLine) => update({ wordsPerLine })}
          options={[
            { value: 1, label: "Una" },
            { value: 2, label: "Due" },
            { value: 3, label: "Tre" },
            { value: 5, label: "Frase" },
          ]}
        />
      </Row>
      <Row label="Posizione">
        <Segmented
          value={settings.position}
          onChange={(position) => update({ position })}
          options={[
            { value: "auto", label: "Auto" },
            { value: "top", label: "Alto" },
            { value: "center", label: "Centro" },
            { value: "bottom", label: "Basso" },
          ]}
        />
      </Row>
      <Row label="Entrata delle parole">
        <Segmented
          value={settings.animation}
          onChange={(animation) => update({ animation })}
          options={[
            { value: "pop", label: "Pop" },
            { value: "bounce", label: "Rimbalzo" },
            { value: "fade", label: "Sfuma" },
            { value: "none", label: "Nessuna" },
          ]}
        />
      </Row>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">Tutto maiuscolo</p>
        <Switch label="Tutto maiuscolo" checked={settings.uppercase} onChange={(uppercase) => update({ uppercase })} />
      </div>
    </div>
  );
}

function ColorRow({ label, value, onChange, allowNone = false }: { label: string; value: string | null; onChange: (v: string | null) => void; allowNone?: boolean }) {
  return (
    <Row label={label}>
      <div className="flex flex-wrap items-center gap-2">
        {allowNone && (
          <button
            onClick={() => onChange(null)}
            aria-pressed={value === null}
            aria-label="Nessun colore"
            className={`flex h-8 w-8 items-center justify-center rounded-full border text-faint transition-transform duration-150 active:scale-90 ${
              value === null ? "border-brand-400 ring-2 ring-brand-400/40" : "border-white/15"
            }`}
          >
            <X size={14} />
          </button>
        )}
        {SWATCHES.map((c) => (
          <button
            key={c}
            onClick={() => onChange(c)}
            aria-pressed={value?.toUpperCase() === c}
            aria-label={`Colore ${c}`}
            className={`h-8 w-8 rounded-full border transition-transform duration-150 active:scale-90 ${
              value?.toUpperCase() === c ? "border-white ring-2 ring-brand-400 ring-offset-2 ring-offset-canvas" : "border-white/15"
            }`}
            style={{ background: c }}
          />
        ))}
        <label className="relative flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-white/25 text-faint" title="Altro colore">
          <Plus size={14} />
          <input type="color" value={value ?? "#ffffff"} onChange={(e) => onChange(e.target.value.toUpperCase())} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Altro colore" />
        </label>
      </div>
    </Row>
  );
}

function ColorsPanel({ settings, update }: { settings: CaptionSettings; update: (p: Partial<CaptionSettings>) => void }) {
  return (
    <div className="space-y-6">
      <ColorRow label="Testo" value={settings.textColor} onChange={(v) => update({ textColor: v ?? "#FFFFFF" })} />
      <ColorRow label="Parole chiave (scelte dall'AI)" value={settings.highlightColor} onChange={(v) => update({ highlightColor: v ?? settings.textColor })} />
      <ColorRow label="Parola che si sta dicendo" value={settings.activeColor} onChange={(v) => update({ activeColor: v })} allowNone />
      <ColorRow label="Urla" value={settings.shoutColor} onChange={(v) => update({ shoutColor: v })} allowNone />
      <ColorRow label="Contorno" value={settings.strokeColor} onChange={(v) => update({ strokeColor: v ?? "#000000" })} />
      <Row label="Spessore del contorno" hint={`${settings.strokeWidth}`}>
        <Slider label="Spessore del contorno" value={settings.strokeWidth} min={0} max={16} onChange={(strokeWidth) => update({ strokeWidth })} />
      </Row>
      <Row label="Ombra" hint={`${settings.shadow}`}>
        <Slider label="Ombra" value={settings.shadow} min={0} max={10} onChange={(shadow) => update({ shadow })} />
      </Row>
      <Row label="Bagliore" hint={`${settings.glow}`}>
        <Slider label="Bagliore" value={settings.glow} min={0} max={10} onChange={(glow) => update({ glow })} />
      </Row>
    </div>
  );
}

function TitlePanel({ settings, updateHeadline, proposed }: { settings: CaptionSettings; updateHeadline: (p: Partial<CaptionSettings["headline"]>) => void; proposed: string | null }) {
  const h = settings.headline;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">Titolo d&apos;apertura</p>
          <p className="text-xs text-muted">Una scritta grande in alto, per dire subito di cosa parla lo Short.</p>
        </div>
        <Switch label="Titolo d'apertura" checked={h.enabled} onChange={(enabled) => updateHeadline({ enabled })} />
      </div>
      <div className={`space-y-6 transition-opacity duration-200 ${h.enabled ? "" : "pointer-events-none opacity-40"}`}>
        <Row label="Testo">
          <input
            className="input"
            maxLength={60}
            value={h.text ?? ""}
            placeholder={proposed ?? "Scrivi il titolo"}
            onChange={(e) => updateHeadline({ text: e.target.value.trim() ? e.target.value : null })}
          />
        </Row>
        <Row label="Stile">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {(Object.keys(HEADLINE_STYLES) as HeadlineStyle[]).map((s) => (
              <button
                key={s}
                onClick={() => updateHeadline({ style: s })}
                aria-pressed={h.style === s}
                className={`rounded-xl border px-2 py-2.5 text-xs font-medium transition-[border-color,background-color,transform] duration-150 active:scale-[0.97] ${
                  h.style === s ? "border-brand-400/60 bg-brand-500/10 text-ink" : "border-white/[0.07] bg-white/[0.03] text-muted hover:border-white/15"
                }`}
              >
                <HeadlineSwatch style={s} />
                {HEADLINE_STYLES[s]}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Quanto resta">
          <Segmented
            value={h.duration}
            onChange={(duration) => updateHeadline({ duration })}
            options={[
              { value: "intro", label: "Primi 3 secondi" },
              { value: "sempre", label: "Tutto lo Short" },
            ]}
          />
        </Row>
      </div>
    </div>
  );
}

function HeadlineSwatch({ style }: { style: HeadlineStyle }) {
  const base = "mx-auto mb-1.5 block w-fit px-1.5 text-[13px] font-black italic leading-tight";
  if (style === "riquadro") return <span className={`${base} rounded bg-[#FFD400] text-[#111]`}>WOW</span>;
  if (style === "neon") return <span className={`${base} text-white`} style={{ textShadow: "0 0 6px #00C8FF, 0 0 12px #00C8FF" }}>WOW</span>;
  const color = style === "bianco" ? "#fff" : style === "verde" ? "#56f07a" : "#ffd21a";
  return (
    <span className={base} style={{ color, WebkitTextStroke: "3px #000", paintOrder: "stroke fill" }}>
      WOW
    </span>
  );
}

function MorePanel({ settings, update, defaultSettings }: { settings: CaptionSettings; update: (p: Partial<CaptionSettings>) => void; defaultSettings: CaptionSettings | null }) {
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const isDefault = same(settings, defaultSettings ?? CLASSIC_CAPTION_SETTINGS);
  async function makeDefault() {
    setState("saving");
    const res = await fetch("/api/caption-default", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings }) });
    setState(res.ok ? "done" : "idle");
  }
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">Barra di avanzamento</p>
          <p className="text-xs text-muted">Una linea in basso che si riempie mentre lo Short va avanti.</p>
        </div>
        <Switch label="Barra di avanzamento" checked={settings.progressBar} onChange={(progressBar) => update({ progressBar })} />
      </div>
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-500/15 text-brand-300">
            <Star size={17} />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <p className="text-sm font-medium text-ink">Stile di partenza</p>
              <p className="text-xs text-muted">I prossimi Shorts usciranno già con questo stile. Puoi sempre cambiarlo Short per Short.</p>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={makeDefault} disabled={isDefault || state === "saving"}>
              {state === "done" || isDefault ? <Check size={14} /> : <Sparkles size={14} />}
              {state === "done" || isDefault ? "È lo stile di partenza" : "Usa come stile di partenza"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Pannello dal basso per dare un nome al preset (sul computer resta un riquadro centrato). */
function NamePresetSheet({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const suggestions = useMemo(() => ["Urla rosse", "Giallo grosso", "Pulito", "Il mio"], []);
  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave(name.trim());
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Errore");
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <button aria-label="Chiudi" onClick={onClose} className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`} />
      <div
        role="dialog"
        aria-label="Nome del preset"
        className={`relative w-full max-w-md rounded-t-3xl border border-white/[0.08] bg-surface p-5 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-pop sm:rounded-3xl sm:pb-5 ${
          open ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"
        }`}
        style={{ transition: "transform 320ms var(--ease-drawer), opacity 200ms ease" }}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20 sm:hidden" />
        <h2 className="text-base font-semibold text-ink">Salva come preset</h2>
        <p className="mt-1 text-sm text-muted">Lo ritrovi in &quot;I tuoi preset&quot;, pronto per gli altri Shorts.</p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input ref={inputRef} className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome del preset" />
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => setName(s)} className="chip transition-colors hover:bg-white/[0.12] hover:text-ink">
                {s}
              </button>
            ))}
          </div>
          {err && <p className="text-xs text-[#ffb3b8]">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Annulla
            </button>
            <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Salva
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

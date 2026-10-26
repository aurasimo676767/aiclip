"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Link2, Layers, Upload } from "lucide-react";
import { YoutubeImportForm } from "./youtube-import-form";
import { UploadForm } from "./upload-form";
import { BulkYoutubeImportForm } from "./bulk-youtube-import-form";

type Tab = "youtube" | "bulk" | "upload";

const TABS: Array<{ id: Tab; label: string; icon: typeof Link2 }> = [
  { id: "youtube", label: "Un link", icon: Link2 },
  { id: "bulk", label: "Più link", icon: Layers },
  { id: "upload", label: "File", icon: Upload },
];

/**
 * Aggiungi un video: un link YouTube (il caso di tutti i giorni), più link insieme o un file.
 * Il segmento acceso scivola sotto la voce scelta.
 */
export function CreateProjectPanel() {
  const [tab, setTab] = useState<Tab>("youtube");
  const listRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`);
    if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
  }, [tab]);

  return (
    <section id="nuovo" className="card scroll-mt-20 space-y-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Aggiungi un video</h2>
          <p className="mt-0.5 text-sm text-muted">L&apos;AI trova i momenti migliori e li monta in verticale.</p>
        </div>
        <div ref={listRef} role="tablist" className="segmented">
          {thumb && <span className="segmented-thumb" style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }} />}
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              data-tab={id}
              role="tab"
              aria-selected={tab === id}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className="segmented-item flex items-center gap-1.5"
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div key={tab} className="animate-fade-in">
        {tab === "youtube" && <YoutubeImportForm />}
        {tab === "bulk" && <BulkYoutubeImportForm />}
        {tab === "upload" && <UploadForm />}
      </div>

      <p className="text-xs text-faint">I VOD di Twitch si importano da Canali, canale per canale.</p>
    </section>
  );
}

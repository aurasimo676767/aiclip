"use client";

import { useState } from "react";
import { Link2, Layers, Upload } from "lucide-react";
import { YoutubeImportForm } from "./youtube-import-form";
import { UploadForm } from "./upload-form";
import { BulkYoutubeImportForm } from "./bulk-youtube-import-form";

type Tab = "youtube" | "bulk" | "upload";

const TABS: Array<{ id: Tab; label: string; icon: typeof Link2 }> = [
  { id: "youtube", label: "Un link", icon: Link2 },
  { id: "bulk", label: "Più link", icon: Layers },
  { id: "upload", label: "Carica file", icon: Upload },
];

export function CreateProjectPanel() {
  const [tab, setTab] = useState<Tab>("youtube");

  return (
    <section id="nuovo" className="relative overflow-hidden rounded-3xl border border-line bg-surface p-6 shadow-card sm:p-8">
      {/* Alone colorato dietro al titolo */}
      <div className="pointer-events-none absolute -top-32 left-1/2 h-64 w-[36rem] -translate-x-1/2 rounded-full bg-brand-500/20 blur-3xl" />
      <div className="pointer-events-none absolute -top-24 right-0 h-48 w-72 rounded-full bg-hot/10 blur-3xl" />

      <div className="relative mx-auto max-w-2xl space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-balance font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Dal video lungo agli <span className="bg-brand-gradient bg-clip-text text-transparent">Shorts</span>, in automatico
          </h1>
          <p className="text-balance text-sm text-muted sm:text-base">Incolla un link: l&apos;AI trova i momenti migliori, li monta in verticale e li prepara per YouTube.</p>
        </div>

        <div className="inline-flex rounded-xl border border-line bg-canvas p-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition sm:text-sm ${
                tab === id ? "bg-raised text-ink shadow-card" : "text-faint hover:text-muted"
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>

        <div className="text-left">
          {tab === "youtube" && <YoutubeImportForm />}
          {tab === "bulk" && <BulkYoutubeImportForm />}
          {tab === "upload" && <UploadForm />}
        </div>

        <p className="text-xs text-faint">I VOD Twitch si importano dal Feed, canale per canale.</p>
      </div>
    </section>
  );
}

"use client";

import { useState } from "react";
import { Link2, Layers, Upload } from "lucide-react";
import { YoutubeImportForm } from "./youtube-import-form";
import { UploadForm } from "./upload-form";
import { BulkYoutubeImportForm } from "./bulk-youtube-import-form";
import { CaptionHeadline } from "./ui-kit/caption-headline";

type Tab = "youtube" | "bulk" | "upload";

const TABS: Array<{ id: Tab; label: string; icon: typeof Link2 }> = [
  { id: "youtube", label: "Un link", icon: Link2 },
  { id: "bulk", label: "Più link", icon: Layers },
  { id: "upload", label: "Carica file", icon: Upload },
];

export function CreateProjectPanel() {
  const [tab, setTab] = useState<Tab>("youtube");

  return (
    <section id="nuovo" className="relative rounded-3xl border border-line bg-surface px-6 pb-7 pt-10 shadow-card sm:px-10 sm:pb-9 sm:pt-14">
      <div className="relative mx-auto max-w-2xl space-y-7 text-center">
        <div className="space-y-4">
          <CaptionHeadline text="Dalla live agli Shorts" className="text-[1.9rem] sm:text-5xl lg:text-6xl" />
          <p className="mx-auto max-w-md text-balance text-sm text-muted sm:text-base">
            Incolla un link: l&apos;AI trova i momenti migliori, li monta in verticale e li prepara per YouTube.
          </p>
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

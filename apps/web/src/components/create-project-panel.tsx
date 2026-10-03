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

/**
 * Il riquadro per partire: il link da incollare è la cosa più importante della home, quindi sta in
 * primo piano, allineato a sinistra come un campo di ricerca. Dietro c'è un fotogramma dell'ultima
 * live (la copertina dell'ultimo progetto), sfumato: la home ha subito la faccia dei video di simo
 * invece di un riquadro vuoto.
 */
export function CreateProjectPanel({ backdropUrl = null }: { backdropUrl?: string | null }) {
  const [tab, setTab] = useState<Tab>("youtube");

  return (
    <section id="nuovo" className="relative isolate scroll-mt-20 overflow-hidden rounded-3xl border border-white/[0.06] bg-surface">
      {backdropUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={backdropUrl}
          alt=""
          aria-hidden
          className="absolute inset-x-0 top-0 -z-10 h-64 w-full object-cover opacity-60 saturate-[1.15] [mask-image:linear-gradient(to_bottom,black_30%,transparent)] md:inset-y-0 md:left-auto md:right-0 md:h-full md:w-[64%] md:[mask-image:linear-gradient(to_right,transparent,black_55%)]"
        />
      )}
      <div className="relative max-w-2xl space-y-6 px-5 pb-6 pt-36 sm:px-10 md:pb-12 md:pt-14">
        <div className="space-y-3">
          <CaptionHeadline text="Dalla live agli Shorts" className="text-[2.35rem] sm:text-5xl lg:text-6xl" />
          <p className="max-w-md text-[15px] leading-relaxed text-muted sm:text-base">
            Incolla un link: l&apos;AI trova i momenti migliori, li monta in verticale e li prepara per YouTube.
          </p>
        </div>

        <div className="inline-flex rounded-xl border border-white/[0.07] bg-black/40 p-1 backdrop-blur">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition sm:text-sm ${
                tab === id ? "bg-white/10 text-ink" : "text-faint hover:text-muted"
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>

        <div>
          {tab === "youtube" && <YoutubeImportForm />}
          {tab === "bulk" && <BulkYoutubeImportForm />}
          {tab === "upload" && <UploadForm />}
        </div>

        <p className="text-xs text-faint">I VOD Twitch si importano dal Feed, canale per canale.</p>
      </div>
    </section>
  );
}

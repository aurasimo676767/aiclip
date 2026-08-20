"use client";

import { useState } from "react";
import { YoutubeImportForm } from "./youtube-import-form";
import { UploadForm } from "./upload-form";

type Tab = "youtube" | "upload";

export function CreateProjectPanel() {
  const [tab, setTab] = useState<Tab>("youtube");

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
      <div className="mb-4 flex gap-1 rounded-lg bg-zinc-950/60 p-1 text-sm">
        <button
          onClick={() => setTab("youtube")}
          className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${
            tab === "youtube" ? "bg-brand-500 text-white" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Link YouTube
        </button>
        <button
          onClick={() => setTab("upload")}
          className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${
            tab === "upload" ? "bg-brand-500 text-white" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Carica file
        </button>
      </div>

      {tab === "youtube" ? <YoutubeImportForm /> : <UploadForm />}
    </div>
  );
}

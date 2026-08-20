"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ALLOWED_VIDEO_MIME_TYPES } from "@clipforge/shared";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Stage = "idle" | "creating" | "uploading" | "finalizing" | "error";

export function UploadForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);

  const isBusy = stage === "creating" || stage === "uploading" || stage === "finalizing";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Seleziona un file video");
      return;
    }
    if (!ALLOWED_VIDEO_MIME_TYPES.includes(file.type as (typeof ALLOWED_VIDEO_MIME_TYPES)[number])) {
      setError("Formato non supportato. Usa MP4, MOV, MKV o WebM.");
      return;
    }

    setError(null);
    setStage("creating");

    try {
      const createRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || file.name,
          originalFilename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        }),
      });
      const created = await createRes.json();
      if (!createRes.ok) {
        throw new Error(created.error ?? "Creazione progetto fallita");
      }

      setStage("uploading");
      const supabase = createSupabaseBrowserClient();
      const { error: uploadError } = await supabase.storage
        .from(created.bucket)
        .uploadToSignedUrl(created.storagePath, created.token, file);
      if (uploadError) {
        throw new Error(`Upload fallito: ${uploadError.message}`);
      }

      setStage("finalizing");
      const completeRes = await fetch(`/api/projects/${created.projectId}/complete-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: created.videoId }),
      });
      const completed = await completeRes.json();
      if (!completeRes.ok) {
        throw new Error(completed.error ?? "Finalizzazione upload fallita");
      }

      router.push(`/dashboard/projects/${created.projectId}`);
    } catch (err) {
      setStage("error");
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-xl space-y-6">
      <div>
        <label htmlFor="title" className="mb-1 block text-sm font-medium text-zinc-300">
          Titolo progetto
        </label>
        <input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Es. Episodio 42 - Intervista con..."
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-brand-400"
        />
      </div>

      <div>
        <label htmlFor="file" className="mb-1 block text-sm font-medium text-zinc-300">
          Video sorgente
        </label>
        <input
          id="file"
          type="file"
          accept={ALLOWED_VIDEO_MIME_TYPES.join(",")}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-zinc-400 file:mr-4 file:rounded-lg file:border-0 file:bg-brand-500 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-brand-600"
        />
        {file && (
          <p className="mt-1 text-xs text-zinc-500">
            {file.name} — {(file.size / 1024 / 1024).toFixed(1)} MB
          </p>
        )}
      </div>

      <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
        URL YouTube — in arrivo in una fase successiva. Per ora carica un file video.
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={isBusy}
        className="w-full rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
      >
        {stage === "creating" && "Creazione progetto..."}
        {stage === "uploading" && "Caricamento in corso..."}
        {stage === "finalizing" && "Finalizzazione..."}
        {(stage === "idle" || stage === "error") && "Carica e avvia analisi"}
      </button>
    </form>
  );
}

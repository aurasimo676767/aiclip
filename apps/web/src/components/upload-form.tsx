"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileVideo, Loader2, UploadCloud } from "lucide-react";
import { ALLOWED_VIDEO_MIME_TYPES } from "@clipforge/shared";

type Stage = "idle" | "creating" | "uploading" | "finalizing" | "error";

const STAGE_LABEL: Record<Stage, string> = {
  idle: "Carica e analizza",
  error: "Carica e analizza",
  creating: "Creo il progetto…",
  uploading: "Caricamento in corso…",
  finalizing: "Finalizzo…",
};

export function UploadForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);

  const isBusy = stage === "creating" || stage === "uploading" || stage === "finalizing";

  function pick(candidate: File | null | undefined) {
    if (!candidate) return;
    setFile(candidate);
    setError(null);
  }

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
      const uploadRes = await fetch(created.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadRes.ok) {
        throw new Error(`Upload fallito (HTTP ${uploadRes.status})`);
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
    <form onSubmit={handleSubmit} className="space-y-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files?.[0]);
        }}
        className={`flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition ${
          dragging ? "border-brand-400 bg-brand-500/10" : "border-line-strong bg-canvas hover:border-faint"
        }`}
      >
        {file ? <FileVideo size={26} className="text-brand-300" /> : <UploadCloud size={26} className="text-faint" />}
        {file ? (
          <span className="text-sm text-ink">
            {file.name} <span className="text-faint">— {(file.size / 1024 / 1024).toFixed(1)} MB</span>
          </span>
        ) : (
          <span className="text-sm text-muted">
            Trascina qui il video, o <span className="text-brand-300">sfoglia</span>
            <span className="block text-xs text-faint">MP4, MOV, MKV o WebM</span>
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_VIDEO_MIME_TYPES.join(",")}
        onChange={(e) => pick(e.target.files?.[0])}
        className="hidden"
      />

      <div className="flex flex-col gap-2 sm:flex-row">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titolo del progetto (facoltativo)" className="input flex-1" />
        <button type="submit" disabled={isBusy || !file} className="btn btn-gradient">
          {isBusy && <Loader2 size={16} className="animate-spin" />}
          {STAGE_LABEL[stage]}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}

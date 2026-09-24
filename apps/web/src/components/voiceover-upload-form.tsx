"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ALLOWED_VIDEO_MIME_TYPES, ALLOWED_AUDIO_MIME_TYPES } from "@clipforge/shared";

type Stage = "idle" | "creating" | "uploading" | "finalizing" | "error";

export function VoiceoverUploadForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);

  const isBusy = stage === "creating" || stage === "uploading" || stage === "finalizing";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!videoFile) {
      setError("Seleziona il file della clip");
      return;
    }
    if (!audioFile) {
      setError("Seleziona il file audio del voice over");
      return;
    }
    if (!ALLOWED_VIDEO_MIME_TYPES.includes(videoFile.type as (typeof ALLOWED_VIDEO_MIME_TYPES)[number])) {
      setError("Formato clip non supportato. Usa MP4, MOV, MKV o WebM.");
      return;
    }
    if (!ALLOWED_AUDIO_MIME_TYPES.includes(audioFile.type as (typeof ALLOWED_AUDIO_MIME_TYPES)[number])) {
      setError("Formato audio non supportato. Usa MP3, WAV o M4A.");
      return;
    }

    setError(null);
    setStage("creating");

    try {
      const createRes = await fetch("/api/voiceover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || videoFile.name,
          video: { originalFilename: videoFile.name, mimeType: videoFile.type, sizeBytes: videoFile.size },
          audio: { originalFilename: audioFile.name, mimeType: audioFile.type, sizeBytes: audioFile.size },
        }),
      });
      const created = await createRes.json();
      if (!createRes.ok) {
        throw new Error(created.error ?? "Creazione job fallita");
      }

      setStage("uploading");
      const [videoUploadRes, audioUploadRes] = await Promise.all([
        fetch(created.videoUploadUrl, { method: "PUT", headers: { "Content-Type": videoFile.type }, body: videoFile }),
        fetch(created.audioUploadUrl, { method: "PUT", headers: { "Content-Type": audioFile.type }, body: audioFile }),
      ]);
      if (!videoUploadRes.ok) throw new Error(`Upload clip fallito (HTTP ${videoUploadRes.status})`);
      if (!audioUploadRes.ok) throw new Error(`Upload audio fallito (HTTP ${audioUploadRes.status})`);

      setStage("finalizing");
      const completeRes = await fetch(`/api/voiceover/${created.jobId}/complete-upload`, { method: "POST" });
      const completed = await completeRes.json();
      if (!completeRes.ok) {
        throw new Error(completed.error ?? "Finalizzazione upload fallita");
      }

      setTitle("");
      setVideoFile(null);
      setAudioFile(null);
      setStage("idle");
      router.refresh();
    } catch (err) {
      setStage("error");
      setError(err instanceof Error ? err.message : "Errore imprevisto");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 card p-5">
      <div>
        <label htmlFor="vo-title" className="label">
          Titolo (opzionale)
        </label>
        <input
          id="vo-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Es. Promo settimana 1"
          className="input"
        />
      </div>

      <div>
        <label htmlFor="vo-video" className="label">
          Clip
        </label>
        <input
          id="vo-video"
          type="file"
          accept={ALLOWED_VIDEO_MIME_TYPES.join(",")}
          onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-muted file:mr-4 file:rounded-lg file:border file:border-line-strong file:bg-raised file:px-4 file:py-2 file:text-sm file:font-medium file:text-ink hover:file:bg-overlay"
        />
        {videoFile && (
          <p className="mt-1 text-xs text-muted">
            {videoFile.name} — {(videoFile.size / 1024 / 1024).toFixed(1)} MB
          </p>
        )}
      </div>

      <div>
        <label htmlFor="vo-audio" className="label">
          Voice over (audio)
        </label>
        <input
          id="vo-audio"
          type="file"
          accept={ALLOWED_AUDIO_MIME_TYPES.join(",")}
          onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-muted file:mr-4 file:rounded-lg file:border file:border-line-strong file:bg-raised file:px-4 file:py-2 file:text-sm file:font-medium file:text-ink hover:file:bg-overlay"
        />
        {audioFile && (
          <p className="mt-1 text-xs text-muted">
            {audioFile.name} — {(audioFile.size / 1024 / 1024).toFixed(1)} MB
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={isBusy}
        className="btn btn-primary w-full"
      >
        {stage === "creating" && "Creazione..."}
        {stage === "uploading" && "Caricamento in corso..."}
        {stage === "finalizing" && "Finalizzazione..."}
        {(stage === "idle" || stage === "error") && "Genera Short"}
      </button>
    </form>
  );
}

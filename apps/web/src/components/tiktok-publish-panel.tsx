"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";

interface CreatorInfo {
  creator_avatar_url: string;
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
  /** true se si pubblica tramite Zernio, che sa programmare. */
  canSchedule?: boolean;
}

const PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Tutti",
  MUTUAL_FOLLOW_FRIENDS: "Amici (follower reciproci)",
  FOLLOWER_OF_CREATOR: "Follower",
  SELF_ONLY: "Solo io",
};

/**
 * Finestra "Pubblica su TikTok" fatta come chiedono le regole della Content Posting API (Direct Post),
 * che TikTok controlla in revisione: account che pubblica, privacy scelta a mano (nessuna preselezionata),
 * commenti/duetti/stitch spenti di partenza, dichiarazione dei contenuti commerciali e consenso
 * all'uso della musica prima del tasto Pubblica.
 */
export function TiktokPublishPanel({
  clipId,
  defaultCaption,
  durationSeconds,
  onDone,
  onCancel,
}: {
  clipId: string;
  defaultCaption: string;
  durationSeconds: number;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [info, setInfo] = useState<CreatorInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [caption, setCaption] = useState(defaultCaption);
  const [privacy, setPrivacy] = useState("");
  const [allowComment, setAllowComment] = useState(false);
  const [allowDuet, setAllowDuet] = useState(false);
  const [allowStitch, setAllowStitch] = useState(false);
  const [commercial, setCommercial] = useState(false);
  const [brandOrganic, setBrandOrganic] = useState(false);
  const [brandContent, setBrandContent] = useState(false);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [scheduleAt, setScheduleAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/tiktok/creator-info")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Impossibile leggere l'account TikTok");
        if (alive) setInfo(data as CreatorInfo);
      })
      .catch((err) => alive && setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, []);

  if (loadError) {
    return (
      <div className="space-y-3">
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{loadError}</p>
        <button onClick={onCancel} className="btn btn-ghost btn-sm">
          Chiudi
        </button>
      </div>
    );
  }
  if (!info) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={14} className="animate-spin" /> Leggo l&apos;account TikTok…
      </p>
    );
  }

  const tooLong = durationSeconds > info.max_video_post_duration_sec;
  const commercialIncomplete = commercial && !brandOrganic && !brandContent;
  const privateBranded = brandContent && privacy === "SELF_ONLY";
  const scheduledDate = when === "later" && scheduleAt ? new Date(scheduleAt) : null;
  const scheduleInvalid = when === "later" && (!scheduledDate || scheduledDate.getTime() < Date.now() + 5 * 60 * 1000);
  const canPublish = !busy && privacy !== "" && !tooLong && !commercialIncomplete && !privateBranded && !scheduleInvalid;

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/publish-tiktok`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caption,
          privacyLevel: privacy,
          allowComment,
          allowDuet,
          allowStitch,
          brandOrganic: commercial && brandOrganic,
          brandContent: commercial && brandContent,
          ...(scheduledDate ? { publishAt: scheduledDate.toISOString() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Pubblicazione non riuscita");
      router.refresh();
      onDone(
        scheduledDate
          ? `Programmato su TikTok per ${scheduledDate.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" })}.`
          : "Inviato a TikTok: il video può impiegare qualche minuto per comparire sul profilo.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const check = (label: string, value: boolean, set: (v: boolean) => void, disabled = false, hint?: string) => (
    <label className={`flex items-center gap-2 text-sm ${disabled ? "text-faint" : "text-ink"}`}>
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => set(e.target.checked)} className="h-4 w-4 accent-brand-400" />
      {label}
      {hint && <span className="text-xs text-faint">({hint})</span>}
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {info.creator_avatar_url && <img src={info.creator_avatar_url} alt="" className="h-9 w-9 rounded-full" />}
        <div className="text-sm">
          <p className="text-muted">Pubblichi su TikTok come</p>
          <p className="font-medium text-ink">
            {info.creator_nickname} <span className="text-faint">@{info.creator_username}</span>
          </p>
        </div>
      </div>

      {tooLong && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Questo video dura {Math.round(durationSeconds)} s: il tuo account TikTok accetta al massimo {info.max_video_post_duration_sec} s.
        </p>
      )}

      <label className="block space-y-1">
        <span className="text-xs text-muted">Descrizione</span>
        <textarea value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={2200} rows={3} className="input w-full resize-y" />
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-muted">Chi può vederlo</span>
        <select value={privacy} onChange={(e) => setPrivacy(e.target.value)} className="input w-full">
          <option value="" disabled>
            Scegli…
          </option>
          {info.privacy_level_options.map((p) => (
            <option key={p} value={p} disabled={p === "SELF_ONLY" && brandContent}>
              {PRIVACY_LABELS[p] ?? p}
            </option>
          ))}
        </select>
      </label>

      <div className="space-y-1.5">
        <p className="text-xs text-muted">Permetti agli altri di</p>
        {check("Commentare", allowComment, setAllowComment, info.comment_disabled, info.comment_disabled ? "disattivato nel tuo account" : undefined)}
        {check("Fare duetti", allowDuet, setAllowDuet, info.duet_disabled, info.duet_disabled ? "disattivato nel tuo account" : undefined)}
        {check("Fare stitch", allowStitch, setAllowStitch, info.stitch_disabled, info.stitch_disabled ? "disattivato nel tuo account" : undefined)}
      </div>

      <div className="space-y-1.5 rounded-xl border border-line p-3">
        {check("Contenuto commerciale (promuove un brand, un prodotto o un servizio)", commercial, setCommercial)}
        {commercial && (
          <div className="space-y-1.5 pl-6">
            {check("Il tuo brand", brandOrganic, setBrandOrganic)}
            {check("Contenuto sponsorizzato (per un altro brand)", brandContent, setBrandContent, privacy === "SELF_ONLY", privacy === "SELF_ONLY" ? "non può essere privato" : undefined)}
            {commercialIncomplete && <p className="text-xs text-amber-300">Scegli almeno una delle due opzioni.</p>}
            {(brandOrganic || brandContent) && (
              <p className="text-xs text-muted">
                Il video sarà etichettato come {brandContent ? "“Partnership retribuita”" : "“Contenuto promozionale”"}.
              </p>
            )}
          </div>
        )}
      </div>

      {info.canSchedule && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted">Quando</p>
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink">
            <label className="flex items-center gap-1.5">
              <input type="radio" name="tt-when" checked={when === "now"} onChange={() => setWhen("now")} className="accent-brand-400" /> Subito
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="tt-when" checked={when === "later"} onChange={() => setWhen("later")} className="accent-brand-400" /> Programma
            </label>
            {when === "later" && (
              <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="input py-1.5" />
            )}
          </div>
          {when === "later" && scheduleInvalid && <p className="text-xs text-amber-300">Scegli un orario almeno fra 5 minuti.</p>}
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted">
        Pubblicando accetti la{" "}
        <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer" className="underline">
          Music Usage Confirmation
        </a>
        {brandContent && (
          <>
            {" "}e la{" "}
            <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer" className="underline">
              Branded Content Policy
            </a>
          </>
        )}{" "}
        di TikTok.
      </p>

      {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}

      <div className="flex gap-2">
        <button onClick={publish} disabled={!canPublish} className="btn btn-primary btn-sm">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} {when === "later" ? "Programma su TikTok" : "Pubblica su TikTok"}
        </button>
        <button onClick={onCancel} className="btn btn-ghost btn-sm">
          Annulla
        </button>
      </div>
    </div>
  );
}

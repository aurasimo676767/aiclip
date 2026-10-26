import Link from "next/link";
import { Film, MonitorOff, PauseCircle, Sparkles } from "lucide-react";
import type { PcStatus, PcTask } from "@/lib/data/worker-status";

function ago(iso: string | null): string {
  if (!iso) return "mai visto";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 2) return "adesso";
  if (minutes < 60) return `${minutes} min fa`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "ora" : "ore"} fa`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "giorno" : "giorni"} fa`;
}

const STATE = {
  working: { label: "Acceso · al lavoro", dot: "bg-good", pulse: true },
  idle: { label: "Acceso · libero", dot: "bg-good", pulse: false },
  paused: { label: "In pausa", dot: "bg-warn", pulse: false },
  offline: { label: "Spento", dot: "bg-faint", pulse: false },
} as const;

/** Barra di avanzamento che "scorre" mentre il PC lavora: righe in moto costante sopra il riempimento. */
function ProgressBar({ value }: { value: number | null }) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
      {/* Riempimento con clip-path e non con la larghezza: si anima sulla GPU, senza ricalcolare il layout. */}
      <div
        className="relative h-full w-full rounded-full bg-brand-500"
        style={{ clipPath: `inset(0 ${100 - Math.max(6, value ?? 35)}% 0 0 round 999px)`, transition: "clip-path 700ms var(--ease-out)" }}
      >
        <div className="absolute inset-0 animate-progress-stripes rounded-full bg-[repeating-linear-gradient(-45deg,rgba(255,255,255,0.22)_0_7px,transparent_7px_14px)] bg-[length:28px_28px]" />
      </div>
    </div>
  );
}

function TaskRow({ task, lead }: { task: PcTask; lead: boolean }) {
  return (
    <Link
      href={task.href}
      className={`group flex items-center gap-4 rounded-2xl transition-colors duration-150 ${lead ? "" : "px-1 py-1 hover:bg-white/[0.03]"}`}
    >
      <div
        className={`relative shrink-0 overflow-hidden rounded-xl bg-overlay ring-1 ring-white/[0.06] ${
          task.portrait ? (lead ? "aspect-[9/16] w-[74px]" : "aspect-[9/16] w-10") : lead ? "aspect-video w-[132px]" : "aspect-video w-16"
        }`}
      >
        {task.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={task.imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-faint">
            <Film size={lead ? 22 : 16} />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <p className={`line-clamp-2 font-medium leading-snug text-ink ${lead ? "text-[15px]" : "text-sm"}`}>{task.title}</p>
          <p className="text-xs text-muted">{task.stage}</p>
        </div>
        <ProgressBar value={task.progress} />
      </div>
    </Link>
  );
}

/**
 * "Il PC adesso": la prima cosa della Home (scelta di simo, 2026-10-26). Dice se il PC è acceso,
 * cosa sta facendo e quanto c'è in coda. Se è spento lo dice chiaro: era successo che un amico
 * mettesse uno Short da fare a PC spento e nessuno se ne accorgesse.
 */
export function PcNowPanel({ status, controls }: { status: PcStatus; controls?: React.ReactNode }) {
  const s = STATE[status.state];
  const [lead, ...others] = status.current;
  const queue = [
    status.queuedRenders > 0 ? `${status.queuedRenders} ${status.queuedRenders === 1 ? "Short" : "Shorts"} da renderizzare` : null,
    status.queuedVideos > 0 ? `${status.queuedVideos} ${status.queuedVideos === 1 ? "video" : "video"} da elaborare` : null,
  ].filter(Boolean);

  return (
    <section aria-label="Il PC adesso" className="card overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-white/[0.05] px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            {s.pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${s.dot}`} />}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${s.dot}`} />
          </span>
          <h2 className="text-sm font-semibold text-ink">Il PC adesso</h2>
          <span className="text-sm text-muted">{s.label}</span>
        </div>
        {controls}
      </header>

      <div className="space-y-4 p-5">
        {status.state === "offline" ? (
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-muted">
              <MonitorOff size={20} />
            </div>
            <div className="space-y-1">
              <p className="font-medium text-ink">Il PC è spento</p>
              <p className="text-sm text-muted">
                Ultimo segnale {ago(status.lastSeenAt)}. Quello che metti in coda parte appena si riaccende.
              </p>
            </div>
          </div>
        ) : lead ? (
          <>
            <TaskRow task={lead} lead />
            {others.length > 0 && (
              <div className="space-y-1 border-t border-white/[0.05] pt-3">
                {others.map((t) => (
                  <TaskRow key={t.kind + t.id} task={t} lead={false} />
                ))}
              </div>
            )}
          </>
        ) : status.state === "paused" ? (
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warn/10 text-warn">
              <PauseCircle size={20} />
            </div>
            <p className="pt-2 text-sm text-muted">Il PC è in pausa: niente parte finché non lo riprendi.</p>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-300">
              <Sparkles size={20} />
            </div>
            <p className="pt-2 text-sm text-muted">Il PC è libero. Aggiungi un video qui sotto per dargli lavoro.</p>
          </div>
        )}

        {queue.length > 0 && (
          <p className="flex flex-wrap gap-1.5">
            {queue.map((q) => (
              <span key={q} className="chip tabular-nums">
                In coda: {q}
              </span>
            ))}
          </p>
        )}
      </div>
    </section>
  );
}

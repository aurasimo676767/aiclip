import Link from "next/link";
import { Captions, Film } from "lucide-react";
import type { ReadyShort } from "@/lib/data/worker-status";
import { formatDuration } from "./ui";

/**
 * Gli ultimi Shorts pronti, in una striscia orizzontale da scorrere col pollice (copertine 9:16 come
 * nel feed). Toccando si apre lo Short; il tasto "Stile" porta dritto all'editor dei sottotitoli.
 */
export function ReadyShortsStrip({ shorts }: { shorts: ReadyShort[] }) {
  if (shorts.length === 0) return null;
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <h2 className="text-base font-semibold text-ink">Shorts pronti</h2>
        <Link href="/dashboard/completed" className="text-sm text-muted transition-colors hover:text-ink">
          Tutti i progetti
        </Link>
      </div>
      <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:-mx-0 sm:px-0">
        {shorts.map((s, i) => (
          <li
            key={s.id}
            className="w-[38%] min-w-[132px] max-w-[176px] shrink-0 snap-start animate-fade-in"
            style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}
          >
            <div className="group relative aspect-[9/16] overflow-hidden rounded-2xl bg-raised ring-1 ring-white/[0.06]">
              <Link href={`/dashboard/projects/${s.projectId}?clip=${s.id}`} className="absolute inset-0" aria-label={s.title}>
                {s.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-faint">
                    <Film size={24} />
                  </div>
                )}
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/0 to-black/30" />
                <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white backdrop-blur">
                  {formatDuration(s.duration)}
                </span>
                {s.publishedOnYoutube && (
                  <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur" title="Pubblicato su YouTube">
                    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden><rect x="2" y="5" width="20" height="14" rx="4" fill="#ff3d3d" /><path d="M10 9v6l5-3-5-3z" fill="#fff" /></svg>
                  </span>
                )}
                <p className="absolute inset-x-2.5 bottom-12 line-clamp-3 text-[13px] font-semibold leading-tight text-white">{s.title}</p>
              </Link>
              <Link
                href={`/dashboard/clips/${s.id}/stile`}
                className="absolute inset-x-2 bottom-2 flex items-center justify-center gap-1.5 rounded-xl bg-white/[0.14] py-2 text-xs font-semibold text-white backdrop-blur-md transition-colors hover:bg-white/[0.22] active:scale-[0.97]"
              >
                <Captions size={14} /> Stile
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

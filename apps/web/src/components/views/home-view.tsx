import Link from "next/link";
import type { ProjectSummary } from "@/lib/data/projects";
import type { PcStatus, ReadyShort } from "@/lib/data/worker-status";
import { ProjectList } from "@/components/project-list";
import { CreateProjectPanel } from "@/components/create-project-panel";
import { PcNowPanel } from "@/components/pc-now-panel";
import { ReadyShortsStrip } from "@/components/ready-shorts-strip";
import { WorkerPauseControl } from "@/components/worker-pause-control";

/**
 * Home, dall'alto: cosa sta facendo il PC adesso (scelta di simo, 2026-10-26), aggiungere un video,
 * gli ultimi Shorts pronti da sistemare, i progetti recenti. Separata dalla pagina per poterla
 * provare in /dev-preview con dati finti.
 */
export function HomeView({ summaries, pc, shorts }: { summaries: ProjectSummary[]; pc: PcStatus; shorts: ReadyShort[] }) {
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PcNowPanel status={pc} controls={pc.state === "offline" ? null : <WorkerPauseControl compact />} />
      <CreateProjectPanel />
      <ReadyShortsStrip shorts={shorts} />
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <h2 className="text-base font-semibold text-ink">Progetti recenti</h2>
          <Link href="/dashboard/completed" className="text-sm text-muted transition-colors hover:text-ink">
            Tutti
          </Link>
        </div>
        <ProjectList summaries={summaries} emptyMessage="Aggiungi un video qui sopra per creare il primo progetto." />
      </section>
    </div>
  );
}

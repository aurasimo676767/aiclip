import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ProjectSummary } from "@/lib/data/projects";
import { ProjectList, WorkingRow } from "@/components/project-list";
import { CreateProjectPanel } from "@/components/create-project-panel";
import { isProcessingStatus } from "@/components/status-badge";

/**
 * Corpo della home, separato dalla pagina per poterlo provare in /dev-preview con dati finti.
 * Ordine: il link da incollare, poi cosa sta lavorando adesso (in righe che si leggono al volo),
 * poi i progetti finiti.
 */
export function HomeView({ summaries, limit }: { summaries: ProjectSummary[]; limit: number }) {
  const working = summaries.filter((s) => isProcessingStatus(s.project.status));
  const rest = summaries.filter((s) => !isProcessingStatus(s.project.status));
  // Dietro al riquadro del link: la live in lavorazione adesso, altrimenti la seconda più recente
  // (la prima è già la scheda grande qui sotto, ripeterla subito sopra stonava).
  const backdrop = [...working, ...rest.slice(1), ...rest].find((s) => s.coverUrl)?.coverUrl ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-12">
      <CreateProjectPanel backdropUrl={backdrop} />

      {working.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-bold tracking-tight text-ink" style={{ fontStretch: "112%" }}>
            In lavorazione adesso
          </h2>
          <div className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl border border-white/[0.06] bg-surface/60">
            {working.map((s) => (
              <WorkingRow key={s.project.id} summary={s} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <h2 className="text-lg font-bold tracking-tight text-ink" style={{ fontStretch: "112%" }}>
            Progetti recenti
          </h2>
          <Link href="/dashboard/completed" className="btn btn-ghost btn-sm -mr-2">
            Tutti i completati <ArrowRight size={14} />
          </Link>
        </div>
        <ProjectList
          summaries={rest}
          featureFirst
          emptyMessage={working.length > 0 ? `Gli ultimi ${limit} progetti sono ancora in lavorazione.` : "Incolla un link YouTube qui sopra per creare il primo progetto."}
        />
      </section>
    </div>
  );
}

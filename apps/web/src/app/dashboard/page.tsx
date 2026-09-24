import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { fetchProjectSummaries } from "@/lib/data/projects";
import { ProjectList } from "@/components/project-list";
import { CreateProjectPanel } from "@/components/create-project-panel";
import { PollingRefresher } from "@/components/polling-refresher";
import { isProcessingStatus } from "@/components/status-badge";

// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

// Solo gli ultimi N progetti: la home caricava TUTTI i progetti (e i relativi video/clip) a ogni
// apertura, senza cache (serve "force-dynamic" per il polling in tempo reale) — con l'account
// cresciuto a centinaia di progetti era diventato il principale collo di bottiglia di velocità
// del sito. I progetti più vecchi restano comunque raggiungibili dalle altre tab (Pubblicati,
// Completati, ...).
const RECENT_PROJECTS_LIMIT = 12;

export default async function HomePage() {
  const { supabase } = await requireUser();
  const summaries = await fetchProjectSummaries(supabase, undefined, RECENT_PROJECTS_LIMIT);
  const anyProcessing = summaries.some((s) => isProcessingStatus(s.project.status));

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <PollingRefresher active={anyProcessing} />
      <CreateProjectPanel />

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-xl font-semibold text-ink">Progetti recenti</h2>
            <p className="text-sm text-muted">Gli ultimi {RECENT_PROJECTS_LIMIT}.</p>
          </div>
          <Link href="/dashboard/completed" className="btn btn-ghost btn-sm">
            Tutti i completati <ArrowRight size={14} />
          </Link>
        </div>
        <ProjectList summaries={summaries} emptyMessage="Incolla un link YouTube qui sopra per creare il primo progetto." />
      </section>
    </div>
  );
}

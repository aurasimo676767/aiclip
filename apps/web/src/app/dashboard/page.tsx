import { requireUser } from "@/lib/auth";
import { fetchProjectSummaries } from "@/lib/data/projects";
import { ProjectList } from "@/components/project-list";
import { CreateProjectPanel } from "@/components/create-project-panel";

// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

// Solo gli ultimi N progetti: la home caricava TUTTI i progetti (e i relativi video/clip) a ogni
// apertura, senza cache (serve "force-dynamic" per il polling in tempo reale) — con l'account
// cresciuto a centinaia di progetti era diventato il principale collo di bottiglia di velocità
// del sito. I progetti più vecchi restano comunque raggiungibili dalle altre tab (Pubblicati,
// Completati, ...).
const RECENT_PROJECTS_LIMIT = 10;

export default async function MyClipsPage() {
  const { supabase } = await requireUser();
  const summaries = await fetchProjectSummaries(supabase, undefined, RECENT_PROJECTS_LIMIT);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">My Clips</h1>
        <p className="mt-1 text-sm text-zinc-500">Incolla un link YouTube per iniziare, oppure carica un file.</p>
      </div>

      <CreateProjectPanel />

      <div>
        <p className="mb-3 text-xs text-zinc-600">Gli ultimi {RECENT_PROJECTS_LIMIT} progetti.</p>
        <ProjectList summaries={summaries} emptyMessage="Non hai ancora nessuna clip. Incolla un link YouTube qui sopra per iniziare." />
      </div>
    </div>
  );
}

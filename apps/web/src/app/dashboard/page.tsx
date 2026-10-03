import { requireUser } from "@/lib/auth";
import { fetchProjectSummaries } from "@/lib/data/projects";
import { HomeView } from "@/components/views/home-view";
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
    <>
      <PollingRefresher active={anyProcessing} />
      <HomeView summaries={summaries} limit={RECENT_PROJECTS_LIMIT} />
    </>
  );
}

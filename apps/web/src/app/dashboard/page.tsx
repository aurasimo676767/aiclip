import { requireUser } from "@/lib/auth";
import { fetchProjectSummaries } from "@/lib/data/projects";
import { fetchPcStatus, fetchReadyShorts } from "@/lib/data/worker-status";
import { HomeView } from "@/components/views/home-view";
import { PollingRefresher } from "@/components/polling-refresher";

// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

// Solo gli ultimi N progetti: caricarli tutti a ogni apertura era il collo di bottiglia del sito.
const RECENT_PROJECTS_LIMIT = 9;

export default async function HomePage() {
  const { supabase } = await requireUser();
  const [summaries, pc, shorts] = await Promise.all([
    fetchProjectSummaries(supabase, undefined, RECENT_PROJECTS_LIMIT),
    fetchPcStatus(supabase),
    fetchReadyShorts(supabase),
  ]);

  return (
    <>
      {/* Mentre il PC lavora la Home si aggiorna ogni 4 secondi; da fermo ogni 20, per accorgersi quando riparte. */}
      <PollingRefresher active intervalMs={pc.state === "working" ? 4000 : 20000} />
      <HomeView summaries={summaries} pc={pc} shorts={shorts} />
    </>
  );
}

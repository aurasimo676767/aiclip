import { requireUser } from "@/lib/auth";
import { fetchProjectSummaries } from "@/lib/data/projects";
import { ProjectList } from "@/components/project-list";
import { PageHeader } from "@/components/ui";
import { PollingRefresher } from "@/components/polling-refresher";

// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

export default async function ProcessingPage() {
  const { supabase } = await requireUser();
  const summaries = await fetchProjectSummaries(supabase, [
    "UPLOADING",
    "UPLOADED",
    "DOWNLOADING",
    "EXTRACTING_AUDIO",
    "TRANSCRIBING",
    "ANALYZING",
    "CLIP_SELECTION",
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PollingRefresher active={summaries.length > 0} />
      <PageHeader title="In lavorazione" description="Video che il worker sta scaricando, trascrivendo o analizzando." />
      <ProjectList summaries={summaries} emptyMessage="Nessun progetto in elaborazione al momento." />
    </div>
  );
}

import { requireUser } from "@/lib/auth";
import { fetchProjectSummaries } from "@/lib/data/projects";
import { ProjectList } from "@/components/project-list";

// Vedi commento in dashboard/batch/page.tsx: senza questo, su Vercel i dati possono restare
// cachati anche col polling attivo.
export const dynamic = "force-dynamic";

export default async function ProcessingPage() {
  const { supabase } = await requireUser();
  const summaries = await fetchProjectSummaries(supabase, [
    "UPLOADING",
    "UPLOADED",
    "EXTRACTING_AUDIO",
    "TRANSCRIBING",
    "ANALYZING",
    "CLIP_SELECTION",
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-2xl font-semibold text-white">In elaborazione</h1>
      <ProjectList summaries={summaries} emptyMessage="Nessun progetto in elaborazione al momento." />
    </div>
  );
}

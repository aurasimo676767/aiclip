import { requireUser } from "@/lib/auth";
import { fetchProjectSummaries } from "@/lib/data/projects";
import { ProjectList } from "@/components/project-list";

export default async function CompletedPage() {
  const { supabase } = await requireUser();
  const summaries = await fetchProjectSummaries(supabase, ["READY"]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-2xl font-semibold text-white">Completati</h1>
      <ProjectList summaries={summaries} emptyMessage="Nessun progetto completato ancora." />
    </div>
  );
}

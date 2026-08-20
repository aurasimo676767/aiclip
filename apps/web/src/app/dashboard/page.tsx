import { requireUser } from "@/lib/auth";
import { fetchProjectSummaries } from "@/lib/data/projects";
import { ProjectList } from "@/components/project-list";
import { CreateProjectPanel } from "@/components/create-project-panel";

export default async function MyClipsPage() {
  const { supabase } = await requireUser();
  const summaries = await fetchProjectSummaries(supabase);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">My Clips</h1>
        <p className="mt-1 text-sm text-zinc-500">Incolla un link YouTube per iniziare, oppure carica un file.</p>
      </div>

      <CreateProjectPanel />

      <ProjectList summaries={summaries} emptyMessage="Non hai ancora nessuna clip. Incolla un link YouTube qui sopra per iniziare." />
    </div>
  );
}

import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { fetchProjectSummaries } from "@/lib/data/projects";
import { ProjectList } from "@/components/project-list";

export default async function ProjectsPage() {
  const { supabase } = await requireUser();
  const summaries = await fetchProjectSummaries(supabase);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">I tuoi progetti</h1>
        <Link
          href="/dashboard/new"
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-600"
        >
          + New Project
        </Link>
      </div>
      <ProjectList summaries={summaries} emptyMessage="Non hai ancora nessun progetto. Crea il primo per iniziare." />
    </div>
  );
}

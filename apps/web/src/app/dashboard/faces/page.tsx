import { requireUser } from "@/lib/auth";
import { readFaceIndex, SUGGESTED_FACE_NAMES } from "@/lib/face-library";
import { getPresignedDownloadUrl } from "@/lib/storage/r2";
import { PageHeader } from "@/components/ui";
import { FaceLabeler, type FaceCardData } from "@/components/face-labeler";

export const dynamic = "force-dynamic";

export default async function FacesPage() {
  const { user } = await requireUser();
  const index = await readFaceIndex(user.id);
  const visible = index.faces.filter((f) => f.status !== "rejected");
  const faces: FaceCardData[] = await Promise.all(
    visible.map(async (f) => ({
      id: f.id,
      url: await getPresignedDownloadUrl(f.path, 6 * 3600),
      label: f.label,
      expression: f.expression,
      intensity: f.intensity,
    })),
  );
  // Prima quelle da nominare, le più espressive in cima: sono le più utili per le copertine.
  faces.sort((a, b) => Number(a.label !== null) - Number(b.label !== null) || b.intensity - a.intensity);
  const labeledNames = [...new Set(index.faces.map((f) => f.label).filter((l): l is string => Boolean(l)))];
  const names = [...new Set([...SUGGESTED_FACE_NAMES, ...labeledNames])];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Facce"
        description="Le facce che le copertine possono usare. Tocca il nome giusto sotto ogni faccia, o scartala: nelle copertine finiscono solo quelle con un nome."
      />
      <FaceLabeler faces={faces} names={names} />
    </div>
  );
}

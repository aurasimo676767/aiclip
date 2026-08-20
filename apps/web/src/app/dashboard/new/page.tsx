import { UploadForm } from "@/components/upload-form";

export default function NewProjectPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Nuovo progetto</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Carica un video lungo: verrà trascritto e analizzato automaticamente per trovare i momenti migliori.
        </p>
      </div>
      <UploadForm />
    </div>
  );
}

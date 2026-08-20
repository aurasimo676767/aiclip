import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-8 px-6 text-center">
      <span className="rounded-full border border-brand-400/40 bg-brand-500/10 px-4 py-1 text-xs font-medium uppercase tracking-wide text-brand-200">
        Fase 1 — MVP
      </span>
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
        Trasforma i tuoi video lunghi in <span className="text-brand-300">YouTube Shorts</span> automaticamente
      </h1>
      <p className="max-w-xl text-balance text-lg text-zinc-400">
        Carica un video, l&apos;AI trova i momenti migliori, li trasforma in clip verticali 9:16 con sottotitoli
        sincronizzati ed editing automatico. Pronte da scaricare in pochi minuti.
      </p>
      <div className="flex gap-4">
        <Link
          href="/signup"
          className="rounded-lg bg-brand-500 px-6 py-3 font-medium text-white transition hover:bg-brand-600"
        >
          Inizia gratis
        </Link>
        <Link
          href="/login"
          className="rounded-lg border border-zinc-700 px-6 py-3 font-medium text-zinc-200 transition hover:border-zinc-500"
        >
          Accedi
        </Link>
      </div>
    </main>
  );
}

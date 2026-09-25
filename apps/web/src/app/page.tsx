import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Logo } from "@/components/ui-kit/logo";
import { CaptionHeadline } from "@/components/ui-kit/caption-headline";
import { ShortDemo } from "@/components/landing/short-demo";

// Quello che succede a una live, nell'ordine in cui succede: qui la numerazione è una sequenza vera.
const STEPS = [
  { title: "Incolli il link", text: "Un video YouTube o un VOD Twitch intero, anche di cinque ore." },
  { title: "L'AI guarda la live", text: "Trova dove si urla, si ride o succede qualcosa, e dove comincia e finisce ogni gioco." },
  { title: "Monta in verticale", text: "Webcam sopra, gioco sotto, sottotitoli una parola alla volta, zoom quando serve." },
  { title: "Pubblichi", text: "Shorts e video lunghi pronti, programmati su YouTube quando vuoi." },
];

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <main className="overflow-hidden">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Logo href="/" />
        <nav className="flex items-center gap-2">
          <Link href="/login" className="btn btn-ghost hidden sm:inline-flex">
            Accedi
          </Link>
          <Link href="/signup" className="btn btn-primary">
            Crea account
          </Link>
        </nav>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-14 px-5 pb-20 pt-10 sm:px-8 md:grid-cols-[1.15fr_1fr] md:pb-28 md:pt-16">
        <div className="space-y-7 text-center md:text-left">
          <CaptionHeadline text="Le tue live diventano Shorts" className="text-[2.05rem] sm:text-6xl lg:text-7xl" />
          <p className="mx-auto max-w-md text-base leading-relaxed text-muted md:mx-0 sm:text-lg">
            Incolli un link. ClipForge trova i momenti migliori, li monta in verticale con i sottotitoli e li prepara per YouTube, mentre tu fai altro.
          </p>
          <div className="flex flex-wrap justify-center gap-3 md:justify-start">
            <Link href="/signup" className="btn btn-primary btn-lg">
              Crea il tuo account
            </Link>
            <Link href="/login" className="btn btn-secondary btn-lg">
              Ho già un account
            </Link>
          </div>
        </div>
        <ShortDemo />
      </section>

      <section className="border-t border-line bg-surface/60">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 md:py-20">
          <h2 className="max-w-lg text-2xl font-bold tracking-tight text-ink sm:text-3xl" style={{ fontStretch: "112%" }}>
            Dalla live allo Short, senza toccare un editor
          </h2>
          <ol className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="space-y-2 border-t-2 border-brand-400 pt-4">
                <span className="text-sm font-bold tabular-nums text-brand-400">{i + 1}</span>
                <h3 className="text-lg font-semibold text-ink">{step.title}</h3>
                <p className="max-w-xs text-sm leading-relaxed text-muted">{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl items-center justify-between px-5 py-8 text-sm text-faint sm:px-8">
        <span>ClipForge</span>
        <Link href="/login" className="hover:text-ink">
          Accedi
        </Link>
      </footer>
    </main>
  );
}

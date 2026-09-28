import type { ReactNode } from "react";
import { Logo } from "@/components/ui-kit/logo";

/**
 * Impaginazione delle pagine legali pubbliche (privacy, termini): servono a TikTok per approvare
 * l'app che pubblica i video (Content Posting API) e devono essere raggiungibili senza login.
 */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10 sm:px-8">
      <header className="mb-10">
        <Logo href="/" />
      </header>
      <h1 className="font-display text-3xl font-bold text-ink">{title}</h1>
      <p className="mt-2 text-sm text-muted">Ultimo aggiornamento: {updated}</p>
      <div className="legal mt-8 space-y-5 text-[15px] leading-relaxed text-ink/90 [&_h2]:mt-8 [&_h2]:font-display [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-ink [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
        {children}
      </div>
    </main>
  );
}

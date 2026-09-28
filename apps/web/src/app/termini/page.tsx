import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = { title: "Termini di servizio — ClipForge" };

export default function TermsPage() {
  return (
    <LegalPage title="Termini di servizio" updated="28 settembre 2026">
      <p>Usando ClipForge accetti questi termini.</p>

      <h2>Il servizio</h2>
      <p>
        ClipForge crea clip da video e live che carichi o indichi con un link, e ti permette di pubblicarle sui tuoi canali YouTube e TikTok
        collegati. Le clip si pubblicano solo quando lo chiedi tu.
      </p>

      <h2>I tuoi contenuti</h2>
      <ul>
        <li>Sei responsabile dei video che carichi e pubblichi: devi avere il diritto di usarli (per esempio il permesso dello streamer).</li>
        <li>Quando pubblichi su YouTube o TikTok valgono anche le regole di quella piattaforma.</li>
        <li>I contenuti restano tuoi: ClipForge li usa solo per creare e pubblicare le clip che chiedi.</li>
      </ul>

      <h2>Account collegati</h2>
      <p>
        Collegando un account YouTube o TikTok ci autorizzi a pubblicare i video che scegli. Puoi scollegarlo in qualsiasi momento. Vedi anche
        l&apos;<a href="/privacy" className="underline">informativa sulla privacy</a>.
      </p>

      <h2>Limiti</h2>
      <p>
        Il servizio è fornito così com&apos;è: facciamo il possibile perché funzioni bene, ma non possiamo garantire che sia sempre disponibile o
        senza errori. Possiamo aggiornare questi termini; la data in alto indica l&apos;ultima modifica.
      </p>

      <h2>English summary</h2>
      <p>
        ClipForge creates clips from videos and live streams you provide and publishes them to your connected YouTube and TikTok accounts only
        when you ask. You are responsible for having the rights to the content you upload and publish, and the rules of each platform apply.
        You can disconnect your accounts at any time. The service is provided as is.
      </p>
    </LegalPage>
  );
}

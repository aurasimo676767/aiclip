import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = { title: "Privacy — ClipForge" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Informativa sulla privacy" updated="28 settembre 2026">
      <p>
        ClipForge è uno strumento per creare Shorts e video lunghi dalle live e pubblicarli sui propri canali. Questa pagina spiega quali dati
        usa e perché.
      </p>

      <h2>Dati che raccogliamo</h2>
      <ul>
        <li>L&apos;email con cui crei l&apos;account, per farti accedere.</li>
        <li>I video e i link che carichi, e le clip che ne ricaviamo.</li>
        <li>
          Se colleghi YouTube o TikTok: le informazioni di base del profilo (nome visualizzato, immagine, identificativo dell&apos;account) e i
          token di accesso che la piattaforma ci dà.
        </li>
      </ul>

      <h2>Come li usiamo</h2>
      <ul>
        <li>I token servono SOLO a pubblicare i video che scegli tu, quando lo chiedi tu (subito o all&apos;orario che programmi).</li>
        <li>Non pubblichiamo niente senza una tua azione, non leggiamo messaggi, follower o altri contenuti del tuo account.</li>
        <li>Non vendiamo né condividiamo i tuoi dati con terzi, se non con i servizi tecnici che fanno funzionare il sito (archiviazione dei video, database).</li>
      </ul>

      <h2>Conservazione e cancellazione</h2>
      <p>
        I token restano salvati finché l&apos;account resta collegato. Puoi scollegare YouTube o TikTok in qualsiasi momento dalle impostazioni
        del sito, oppure revocare l&apos;accesso direttamente dalle impostazioni della piattaforma: da quel momento non possiamo più pubblicare.
        Puoi chiedere la cancellazione del tuo account e dei tuoi dati in qualsiasi momento.
      </p>

      <h2>English summary</h2>
      <p>
        ClipForge lets creators turn their live streams into short and long videos and publish them to their own YouTube and TikTok accounts.
        When you connect TikTok we store your basic profile info and the access token TikTok gives us, and we use them only to upload the
        videos you choose to publish. We never post without your action, we do not access other account data, and we do not sell or share your
        data. You can disconnect at any time and ask for your data to be deleted.
      </p>
    </LegalPage>
  );
}

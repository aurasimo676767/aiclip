# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **L'editor** (da fine ottobre 2026): lavora dal **telefono**, sull'account di simo. Fa tutto il giro:
  mette i VOD e i video da elaborare (link Twitch/YouTube o file), sceglie e sistema gli Shorts (stile
  dei sottotitoli, tagli, rigenera), fa copertine e titoli, pubblica e programma su YouTube e TikTok.
- **simo**, il proprietario del canale: anche lui usa il sito quasi sempre dal telefono e controlla
  il risultato guardando i video, non le impostazioni.

## Product Purpose

ClipForge trasforma le live e i video dei creator italiani (Blur, Marza, Manuxo, Pesh e il loro
giro) in Shorts verticali già montati e in montaggi lunghi per YouTube, li pubblica e li programma
su YouTube e TikTok. Successo = Shorts pubblicabili senza ritocchi, fatti in fretta da chi non è un
montatore, e un canale che cresce.

## Positioning

Strumento privato per un solo canale di clip, non un prodotto da vendere: niente pagina pubblica da
convincere, niente piani o crediti per estranei. Il suo vantaggio è fare esattamente come vuole simo
(regole di montaggio, copertine con le facce vere, webcam di chi parla davvero) e tutto in automatico
dal suo PC (worker locale con GPU).

## Operating Context

- Il lavoro pesante lo fa un worker sul PC di simo (download, trascrizione Whisper in locale, AI per
  scegliere le clip, render ffmpeg); il sito su Vercel mostra lo stato e dà i comandi.
- Lingua: solo italiano. Si usa dal telefono, spesso di notte, a tocchi brevi.
- Un render di uno Short dura circa un minuto e mezzo; la scelta delle clip costa credito OpenAI (pochi
  centesimi a video), che simo vuole spendere il meno possibile.

## Capabilities and Constraints

- Progetti da link YouTube/Twitch, da file, in blocco; feed dei canali seguiti.
- Shorts: layout con webcam sopra e gioco sotto, sottotitoli parola per parola (stile attuale "Classico":
  Arial Bold maiuscolo, parola detta in giallo, urla in rosso), titoli, rigenera, taglia, copertine AI
  con le facce della libreria, pubblicazione YouTube e TikTok (anche programmata).
- Long-form: tagli per gioco, montaggio "da YouTuber" con zoom sulle webcam.
- Pagina Facce: simo etichetta le persone; nomi solo da lui.
- In arrivo (ottobre 2026): stile dei sottotitoli e del titolo d'apertura scelto dall'editor, da preset,
  come stile del canale e per singola clip; cambiare solo lo stile rifà il render senza costi AI.

## Brand Commitments

- Nome: ClipForge. Il sito usa i colori degli Shorts che produce (fondo notte, giallo del sottotitolo
  per le azioni, rosso delle urla per ciò che chiede attenzione).
- Tono: diretto, informale, in italiano ("bro"), niente gergo tecnico verso l'utente.
- Look (scelto da simo il 2026-10-26, tra quattro direzioni): **app scura standard**, al livello di
  Opus Clip e CapCut, giocata dritta: pulita, i video al centro, niente temi o costumi. Il vecchio look
  (grana, giallo sottotitolo ovunque) è da sostituire.

## Evidence on Hand

- Clip vere e copertine vere nel database (render su R2): sono gli unici esempi da mostrare.
- Nessun testimonial, nessun dato di vendita: non inventarne.

## Product Principles

1. Il risultato prima delle impostazioni: ogni scelta si vede (anteprima animata), non si descrive.
2. Un tocco col pollice: le azioni di tutti i giorni a portata di mano sul telefono.
3. Nel dubbio, la scelta già provata sul canale (default sensati), le alternative a un tocco.
4. Mai sprecare credito AI: dire prima cosa costa, rifare gratis ciò che può essere gratis.
5. Chi non è un montatore deve capire tutto senza spiegazioni.

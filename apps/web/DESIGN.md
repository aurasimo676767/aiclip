# Design

Look scelto da simo il 2026-10-26: **app scura standard**, al livello di Opus Clip e CapCut, giocata
dritta. I video sono il colore; l'interfaccia sparisce. Niente temi, niente grana, niente ombre dure.
Si usa soprattutto dal telefono, spesso di notte.

## Token (apps/web/tailwind.config.ts)

| Ruolo | Token | Valore |
|---|---|---|
| Fondo pagina | `canvas` | `#0b0b0e` |
| Superficie (schede) | `surface` | `#131317` |
| Rialzata (hover, input) | `raised` | `#1a1a1f` |
| Sovrapposta | `overlay` | `#232329` |
| Linee | `line` / `line-strong` | `#24242b` / `#33333c` (o `white/[0.06]` sui bordi) |
| Testo | `ink` / `muted` / `faint` | `#f4f4f6` / `#a2a2ad` / `#6d6d78` |
| Accento (azione principale, selezione) | `brand-500` (`-400` hover, `-300` icone attive) | `#3570f2` / `#4f86ff` / `#86adff` |
| Testo su accento | `on-brand` | bianco |
| Errore | `hot` | `#f2434f` |
| Acceso / ok | `good` | `#2fd27c` |
| Attenzione / pausa | `warn` | `#f5a524` |
| Solo VOD Twitch | `twitch-*` | viola Twitch |

Un solo accento. I colori dei sottotitoli (giallo, rosso, verde…) vivono solo dentro i video e le
loro anteprime, mai nell'interfaccia.

## Tipografia

Inter (`--font-sans`) per tutto, cifre tabulari su tempi e conteggi (`tabular-nums`). Titoli di
pagina 1.6–1.85rem semibold, sezioni `text-base font-semibold`, testo `text-sm`. Frasi in maiuscola
iniziale, mai etichette sopra i titoli. I font dei sottotitoli (Montserrat Black, Anton, Luckiest
Guy, Arial) stanno in `public/fonts` e servono solo alle anteprime.

## Superfici e profondità

- Schede: `.card` = `rounded-2xl`, bordo `white/[0.06]`, `bg-surface`, `shadow-card` (morbida,
  luce dall'alto). Pannelli che galleggiano (barre d'azione, fogli dal basso): `shadow-pop`.
- Barre di navigazione: vetro (`bg-canvas/80` + `backdrop-blur-xl`) col contenuto che scorre sotto.
- Raggi: 2xl per le schede, xl per pulsanti e campi, lg per i controlli piccoli, 3xl per i fogli.

## Componenti (globals.css)

- `.btn` + `.btn-primary` (azzurro pieno) / `.btn-secondary` / `.btn-ghost` / `.btn-danger` /
  `.btn-white`; `.btn-sm`, `.btn-lg`. Pressione: `scale(0.97)`.
- `.input`, `.label`, `.chip`, `.skeleton`.
- `.segmented` + `.segmented-item` + `.segmented-thumb`: scelte esclusive, il segmento acceso scivola.
- `.switch` (`role="switch"`, `aria-checked`).

## Movimento

Curve: `--ease-out` `cubic-bezier(0.23,1,0.32,1)` per entrate e risposte, `--ease-drawer`
`cubic-bezier(0.32,0.72,0,1)` per i fogli dal basso. Durate UI 150–250ms, fogli 320–380ms.
Solo `transform`, `opacity`, `clip-path`. Entrate in lista sfalsate di 35–40ms. Con
`prefers-reduced-motion` restano solo dissolvenze brevi.

Movimento firma: i sottotitoli che entrano nelle anteprime dei preset e sul video nell'editor
(classi `.cap-anim-*`), copiati dalle entrate che il worker scrive in ASS.

## Navigazione

Telefono: barra in basso (Home, Progetti, + Nuovo video, Pubblicati, Altro) e foglio "Altro" dal
basso con gli strumenti. Computer: barra laterale riducibile. Home: "Il PC adesso", Aggiungi un
video, Shorts pronti, Progetti recenti.

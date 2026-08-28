# ClipForge

Piattaforma SaaS proprietaria per la generazione automatica di YouTube Shorts da video lunghi: upload → trascrizione → analisi AI → clip 9:16 con editing automatico e sottotitoli sincronizzati → download.

**Fase 1 (MVP)**: upload → transcript → AI clip detection → selezione clip → verticalizzazione 9:16 → captions → editing automatico di base → render → preview → download → pubblicazione su YouTube. Non implementati in questa fase: pagamenti, mobile app, team, scheduling social, multi-lingua avanzato, AI B-roll, avatar AI.

## Architettura

```
apps/
  web/      Next.js 14 (App Router) — dashboard, auth, upload, API route "leggere". Deploy: Vercel.
  worker/   Node.js — pipeline di elaborazione video (ffmpeg, Whisper, Claude). Deploy: container separato
            (Railway/Fly.io/VPS/qualsiasi host che esegua Docker o Node) — MAI su Vercel.
packages/
  shared/   Tipi e zod schema condivisi (Transcript, Clip, EDL, Template, Job status).
  db/       Schema SQL Supabase/Postgres + client tipizzato.
```

Il frontend e le API route leggere (creazione progetto, signed URL, creazione render job) girano su Vercel. Il worker interroga la coda (tabella Postgres, claim atomico via `SELECT ... FOR UPDATE SKIP LOCKED` esposto come funzione RPC) e fa tutto il lavoro pesante: estrazione audio, trascrizione, analisi AI, rendering ffmpeg. Frontend e worker comunicano solo attraverso il database e lo storage — nessuna chiamata diretta tra i due, quindi il worker scala e si sostituisce in autonomia.

**Interfacce pensate per essere sostituite** (Fase 1 usa l'implementazione più semplice/economica, dietro un contratto chiaro):
- `TranscriptionProvider` → `OpenAIWhisperProvider` (Whisper API, default) oppure `LocalFasterWhisperProvider` (faster-whisper self-hosted sulla GPU locale, gratis, stessi timestamp a livello di parola — vedi `apps/worker/whisper-server/README.md`), selezionabile via `TRANSCRIPTION_PROVIDER=openai|local`.
- `StorageProvider` → `R2StorageProvider` (Cloudflare R2, compatibile S3). Un'implementazione `SupabaseStorageProvider` alternativa esiste ancora nel codice ma non è usata di default: il piano Free di Supabase Storage limita ogni file a 50MB, troppo poco per video sorgente.
- `FaceTracker` → `ReactionCamFaceTracker`: rilevamento volto reale (ONNX, Ultra-Light-Fast-Generic-Face-Detector, ~1.2MB, `onnxruntime-node` — binari precompilati, nessuna compilazione nativa richiesta) su alcuni frame campionati della clip. Se trova un volto piccolo e stabile vicino a un bordo (webcam in sovraimpressione su gameplay/reaction) produce un layout split-screen (webcam sopra, contenuto sotto); se trova un volto "normale" centra il crop su di esso; altrimenti ricade su `CenterCropFaceTracker` (crop centrato statico). Modello in `apps/worker/models/`.
- Rendering: FFmpeg puro (crop, zoompan-style zoom via espressioni, sottotitoli ASS/libass) invece di Remotion — più economico e veloce per gli obiettivi di Fase 1; Remotion resta un'opzione futura dietro un eventuale `RenderEngine`.
- Pubblicazione YouTube: OAuth Google (`youtube` scope, serve anche a `videos.update` per l'annullamento programmazione) + coda dedicata (`youtube_publish_jobs`, stesso pattern di `render_jobs`). Il worker carica il file su YouTube via `googleapis` — mai da Vercel. Titolo/descrizione/hashtag sono precompilati dall'AI (generati nello stesso passaggio di ranking, nessuna chiamata extra) e modificabili prima di pubblicare.
- **Video long-form da VOD Twitch** (`clips.format = 'longform'`): a differenza degli Shorts, niente crop 9:16/zoom/sottotitoli — un secondo passaggio AI (`longform-candidates.ts`/`longform-ranking.ts`) individua segmenti coerenti per ARGOMENTO (5-20 min) invece di finestre hook-payoff, e il render (`render-longform-clip.ts`) è solo trim + card testuale dei crediti allo streamer originale in apertura/chiusura, output orizzontale nella risoluzione nativa. L'ingestion riusa `download-youtube.ts` as-is (yt-dlp supporta i VOD Twitch nativamente). I VOD arrivano dalla tab Feed seguendo canali Twitch (`followed_twitch_channels`, nessun OAuth richiesto — vedi sezione 3b).

## Setup

### Prerequisiti

- Node.js ≥ 20, pnpm (`corepack enable && corepack prepare pnpm@latest --activate`)
- FFmpeg nel PATH (`ffmpeg -version` deve funzionare)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) nel PATH (`yt-dlp --version` deve funzionare) — usato per l'import da link YouTube
- Un progetto [Supabase](https://supabase.com) (free tier va bene — Auth + Postgres)
- Un account [Cloudflare](https://dash.cloudflare.com) con un bucket [R2](https://developers.cloudflare.com/r2/) (free tier: 10GB, nessun limite per singolo file)
- Una API key [Anthropic](https://console.anthropic.com/)
- Una API key [OpenAI](https://platform.openai.com/api-keys) (usata solo per Whisper)
- Un progetto [Google Cloud](https://console.cloud.google.com) con OAuth configurato (solo se vuoi la pubblicazione automatica su YouTube — vedi sezione 3)
- Un'app [Twitch](https://dev.twitch.tv) registrata (solo se vuoi i video long-form dai VOD — vedi sezione 3b)

### 1. Progetto Supabase

1. Crea un nuovo progetto su supabase.com.
2. Vai su **SQL Editor** ed esegui, in ordine, il contenuto di:
   - `packages/db/migrations/0001_init.sql`
   - `packages/db/migrations/0002_queue_functions.sql`
   - `packages/db/migrations/0003_add_downloading_status.sql`
   - `packages/db/migrations/0004_youtube_publishing.sql`
   - `packages/db/migrations/0005_clip_caption.sql`
   - `packages/db/migrations/0006_youtube_scheduled_publish.sql`
   - `packages/db/migrations/0007_followed_channels.sql`
   - `packages/db/migrations/0008_clip_badges.sql`
   - `packages/db/migrations/0009_youtube_stats.sql`
   - `packages/db/migrations/0010_project_auto_generate.sql`
   - `packages/db/migrations/0011_cancel_jobs.sql`
   - `packages/db/migrations/0012_voiceover_jobs.sql`
   - `packages/db/migrations/0013_youtube_publish_cancel.sql`
   - `packages/db/migrations/0014_longform_twitch.sql`
3. Vai su **Project Settings → API** e copia `URL` e `anon public key` (servono al frontend). Vai su **Project Settings → API → Service role** e copia anche quella (serve solo al worker).

### 2. Bucket Cloudflare R2

1. dash.cloudflare.com → **R2 Object Storage** → **Create bucket** → nome a piacere (es. `clipforge-media`) → Location: Automatic.
2. **Manage R2 API Tokens** → **Create API Token** → permessi **Object Read & Write**, scope limitato al bucket appena creato → copia **Access Key ID** e **Secret Access Key** (mostrata una sola volta).
3. Copia anche l'**Account ID** (visibile nella sidebar destra della pagina R2, o nell'URL del dashboard: `dash.cloudflare.com/<ACCOUNT_ID>/r2`).
4. Se userai anche l'upload da file dal browser (non solo link YouTube), apri il bucket → **Settings → CORS Policy** → **Add CORS policy** e incolla:
   ```json
   [
     {
       "AllowedOrigins": ["http://localhost:3000", "https://il-tuo-dominio.vercel.app"],
       "AllowedMethods": ["PUT", "GET"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   (senza questo, l'upload diretto dal browser viene bloccato dal CORS — l'import da YouTube non ne ha bisogno, passa tutto dal worker)

### 3. OAuth Google/YouTube (opzionale — solo per pubblicare automaticamente)

1. console.cloud.google.com → crea un progetto.
2. **API e servizi → Libreria** → cerca "YouTube Data API v3" → **Abilita**.
3. **API e servizi → Schermata consenso OAuth** → tipo **Esterno** → compila i campi minimi → in **Utenti di test** aggiungi il tuo account Google (così l'app resta in modalità Test, nessuna revisione Google necessaria per uso personale).
4. **API e servizi → Credenziali → Crea credenziali → ID client OAuth** → tipo **Applicazione web** → URI di reindirizzamento autorizzati:
   ```
   http://localhost:3000/api/youtube/callback
   https://il-tuo-dominio.vercel.app/api/youtube/callback
   ```
5. Copia **Client ID** e **Client Secret**.

Nota sulla quota: da giugno 2026 `videos.insert` ha un bucket dedicato separato dal resto della quota, **100 upload/giorno** gratis (1 unità a chiamata in quel bucket) — molto più permissivo del vecchio limite (~6/giorno, quando l'upload costava 1.600 delle 10.000 unità condivise).

### 3b. Twitch API (opzionale — solo per i video long-form dai VOD)

A differenza di YouTube, Twitch non richiede un flusso OAuth per-utente per leggere canali/VOD pubblici: basta un'app registrata una volta.

1. dev.twitch.tv → **Console → Applications → Register Your Application**.
2. Nome a piacere, **OAuth Redirect URLs**: `http://localhost` (non viene mai usato, Twitch lo richiede comunque per registrare l'app), **Category**: `Application Integration`.
3. Copia **Client ID** e genera/copia un **Client Secret**.

Nessun URI di redirect reale, nessuna schermata di consenso, nessun "utente di test": le chiamate (risoluzione canale, lista VOD) usano un app access token server-to-server richiesto al volo dal backend web (`apps/web/src/lib/twitch-scan.ts`).

### 4. Variabili d'ambiente

`pnpm --filter` esegue ogni app nella propria cartella, quindi servono **due file separati** (non uno alla radice) — `.env.example` alla radice resta solo come riferimento con la lista completa delle variabili:

```bash
cp .env.example apps/worker/.env
cp .env.example apps/web/.env.local
```

Compila entrambi con i valori di Supabase/R2/Anthropic/OpenAI (`apps/web/.env.local` non ha bisogno delle variabili solo-worker come `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`SUPABASE_SERVICE_ROLE_KEY`, ma lasciarle non fa danno). **Non committare mai questi file** (sono già in `.gitignore`).

### 5. Installazione

```bash
pnpm install
```

### 6. Avvio in locale

Servono due processi separati (frontend e worker), in due terminali:

```bash
pnpm dev:web      # http://localhost:3000
pnpm dev:worker   # poll continuo della coda su Supabase
```

### 7. Provare il flusso completo

1. Apri `http://localhost:3000`, registrati (`/signup`), conferma l'email se richiesto da Supabase.
2. Nella dashboard (**My Clips**), incolla un link YouTube e clicca **Importa e analizza** (oppure passa al tab **Carica file** per un video da PC).
3. Il worker (deve essere in esecuzione) lo prende in carico automaticamente: (download da YouTube se applicabile →) estrazione audio → trascrizione Whisper → analisi Claude (Haiku poi Sonnet) → clip suggerite.
4. Nella pagina del progetto: seleziona una o più clip → **Generate Shorts**.
5. Il worker le renderizza (crop 9:16, captions, zoom, hook text). Ricarica/attendi il polling automatico.
6. **Preview** per riprodurre nel browser, **Scarica MP4** per il download.

## Comandi utili

```bash
pnpm -r typecheck        # type-check di tutti i package
pnpm --filter @clipforge/web build     # build di produzione del frontend
pnpm --filter @clipforge/worker build  # bundle di produzione del worker (esbuild → dist/index.js)
pnpm --filter @clipforge/worker exec tsx src/dev/smoke-test-render.ts <path-video>
  # smoke test della sola pipeline di render (crop/zoom/captions/loudness), senza bisogno
  # di credenziali Supabase/Anthropic/OpenAI — utile per verificare rapidamente ffmpeg.
```

## Deploy

- **Frontend (`apps/web`)**: Vercel, root directory `apps/web`. Variabili d'ambiente da impostare nel progetto Vercel: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (solo se vuoi la pubblicazione YouTube), `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` (solo se vuoi i video long-form dai VOD Twitch). Ricorda di aggiungere il dominio Vercel definitivo sia alla CORS policy del bucket R2 sia agli URI di reindirizzamento autorizzati del client OAuth Google (vedi sopra).
- **Worker (`apps/worker`)**: qualsiasi host capace di eseguire un processo Node long-running (Railway, Fly.io, un VPS con Docker/systemd, ecc.) — **non Vercel**, che non è pensato per processi persistenti né per rendering video pesante. Build: `pnpm --filter @clipforge/worker build`, avvio: `pnpm --filter @clipforge/worker start` (richiede ffmpeg **e** yt-dlp installati nell'immagine/host; `apps/worker/models/` e `node_modules` devono essere presenti accanto a `dist/` — `onnxruntime-node` ha un addon nativo per piattaforma che esbuild lascia esterno, vedi commento in `scripts/build.mjs`).

## Limitazioni note di questa Fase 1

- **Font dei sottotitoli**: i template referenziano font (Montserrat, Poppins, Anton, ...) che libass risolve tramite i font di sistema disponibili sulla macchina che esegue il worker; se non installati, libass usa un fallback (i sottotitoli restano leggibili ma con font diverso). Per un deploy in produzione, valuta di includere i file `.ttf` nell'immagine del worker e puntarli esplicitamente.
- **Reaction-cam / face tracking**: euristica basata su rilevamento volto reale (non un vero riconoscimento di "finestra webcam"): funziona bene per il caso comune (bolla fissa in un angolo, piccola rispetto al frame) ma può non attivarsi con overlay non standard (bolla grande, posizione centrale, forma non tipica). Nessun tracking frame-per-frame: il crop è fisso per l'intera durata della clip, calcolato da alcuni frame campionati.
- **Loudness normalization**: `loudnorm` a singolo passaggio (non i due passaggi raccomandati per la massima precisione) — scelta per semplicità/velocità.
- **Pubblicazione automatica su YouTube**: richiede un client OAuth Google in modalità "Testing" — funziona solo per gli account aggiunti come "Utenti di test" nella schermata di consenso (limite Google, non dell'app); passare in produzione richiede la revisione dell'app da parte di Google. Quota gratuita: `videos.insert` ha un bucket dedicato da 100 upload/giorno (aggiornato da giugno 2026, prima erano ~6/giorno).
- **Import da YouTube**: usa `yt-dlp`, quindi eredita i suoi limiti — video privati, con restrizione età o soggetti a protezioni anti-bot possono fallire il download; nessun supporto per playlist (viene scaricato solo il video singolo).

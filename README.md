# ClipForge

Piattaforma SaaS proprietaria per la generazione automatica di YouTube Shorts da video lunghi: upload → trascrizione → analisi AI → clip 9:16 con editing automatico e sottotitoli sincronizzati → download.

**Fase 1 (MVP)**: upload → transcript → AI clip detection → selezione clip → verticalizzazione 9:16 → captions → editing automatico di base → render → preview → download. Non implementati in questa fase: pagamenti, mobile app, team, scheduling social, multi-lingua avanzato, AI B-roll, avatar AI, pubblicazione automatica su YouTube.

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
- `TranscriptionProvider` → `OpenAIWhisperProvider` (Whisper API). Sostituibile con un provider self-hosted.
- `StorageProvider` → `SupabaseStorageProvider`. Sostituibile con Cloudflare R2/S3.
- `FaceTracker` → `CenterCropFaceTracker` (crop centrato statico, **nessun rilevamento volto reale**). Interfaccia pronta per un tracker basato su un modello ML.
- Rendering: FFmpeg puro (crop, zoompan-style zoom via espressioni, sottotitoli ASS/libass) invece di Remotion — più economico e veloce per gli obiettivi di Fase 1; Remotion resta un'opzione futura dietro un eventuale `RenderEngine`.
- Pubblicazione YouTube: non implementata. Andrebbe aggiunta come `Publisher` interface + OAuth YouTube Data API v3.

## Setup

### Prerequisiti

- Node.js ≥ 20, pnpm (`corepack enable && corepack prepare pnpm@latest --activate`)
- FFmpeg nel PATH (`ffmpeg -version` deve funzionare)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) nel PATH (`yt-dlp --version` deve funzionare) — usato per l'import da link YouTube
- Un progetto [Supabase](https://supabase.com) (free tier va bene)
- Una API key [Anthropic](https://console.anthropic.com/)
- Una API key [OpenAI](https://platform.openai.com/api-keys) (usata solo per Whisper)

### 1. Progetto Supabase

1. Crea un nuovo progetto su supabase.com.
2. Vai su **SQL Editor** ed esegui, in ordine, il contenuto di:
   - `packages/db/migrations/0001_init.sql`
   - `packages/db/migrations/0002_queue_functions.sql`
   - `packages/db/migrations/0003_add_downloading_status.sql`
3. Vai su **Storage** e crea un bucket **privato** chiamato `clipforge-media` (o il nome che metterai in `STORAGE_BUCKET`).
4. Vai su **Project Settings → API** e copia `URL`, `anon public key`, `service_role key`.

### 2. Variabili d'ambiente

`pnpm --filter` esegue ogni app nella propria cartella, quindi servono **due file separati** (non uno alla radice) — `.env.example` alla radice resta solo come riferimento con la lista completa delle variabili:

```bash
cp .env.example apps/worker/.env
cp .env.example apps/web/.env.local
```

Compila entrambi con i valori di Supabase/Anthropic/OpenAI (`apps/web/.env.local` non ha bisogno delle variabili solo-worker come `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, ma lasciarle non fa danno). **Non committare mai questi file** (sono già in `.gitignore`).

### 3. Installazione

```bash
pnpm install
```

### 4. Avvio in locale

Servono due processi separati (frontend e worker), in due terminali:

```bash
pnpm dev:web      # http://localhost:3000
pnpm dev:worker   # poll continuo della coda su Supabase
```

### 5. Provare il flusso completo

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

- **Frontend (`apps/web`)**: Vercel, root directory `apps/web`. Variabili d'ambiente da impostare nel progetto Vercel: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET`.
- **Worker (`apps/worker`)**: qualsiasi host capace di eseguire un processo Node long-running (Railway, Fly.io, un VPS con Docker/systemd, ecc.) — **non Vercel**, che non è pensato per processi persistenti né per rendering video pesante. Build: `pnpm --filter @clipforge/worker build`, avvio: `pnpm --filter @clipforge/worker start` (richiede ffmpeg **e** yt-dlp installati nell'immagine/host).

## Limitazioni note di questa Fase 1

- **Font dei sottotitoli**: i template referenziano font (Montserrat, Poppins, Anton, ...) che libass risolve tramite i font di sistema disponibili sulla macchina che esegue il worker; se non installati, libass usa un fallback (i sottotitoli restano leggibili ma con font diverso). Per un deploy in produzione, valuta di includere i file `.ttf` nell'immagine del worker e puntarli esplicitamente.
- **Face tracking**: crop centrato statico, non un vero rilevamento volto (vedi `CenterCropFaceTracker`).
- **Loudness normalization**: `loudnorm` a singolo passaggio (non i due passaggi raccomandati per la massima precisione) — scelta per semplicità/velocità.
- **YouTube URL come sorgente**: non implementato (vedi sopra).
- **Pubblicazione automatica su YouTube**: non implementata.
- **Import da YouTube**: usa `yt-dlp`, quindi eredita i suoi limiti — video privati, con restrizione età o soggetti a protezioni anti-bot possono fallire il download; nessun supporto per playlist (viene scaricato solo il video singolo).

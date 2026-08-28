-- ClipForge — video "long-form" da VOD Twitch (pezzi di live divisi per argomento, pubblicati
-- su YouTube come video orizzontali normali invece che Shorts verticali: niente crop/zoom/
-- sottotitoli, solo trim + card dei crediti allo streamer originale in apertura/chiusura).

-- ---------------------------------------------------------------------------
-- followed_twitch_channels — canali Twitch seguiti per lo scan dei VOD recenti (stesso ruolo di
-- followed_channels per YouTube, ma Twitch non richiede OAuth per-utente: solo un app token
-- server-to-server via TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET, vedi apps/web/src/lib/twitch-scan.ts).
-- ---------------------------------------------------------------------------
create table if not exists public.followed_twitch_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  twitch_user_id text not null,
  login text not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, twitch_user_id)
);

alter table public.followed_twitch_channels enable row level security;

create policy "followed_twitch_channels_select_own" on public.followed_twitch_channels for select using (auth.uid() = user_id);
create policy "followed_twitch_channels_insert_own" on public.followed_twitch_channels for insert with check (auth.uid() = user_id);
create policy "followed_twitch_channels_delete_own" on public.followed_twitch_channels for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- clips.format — distingue Short verticale (default, comportamento invariato) da video
-- long-form orizzontale (un segmento per argomento estratto da un VOD).
-- ---------------------------------------------------------------------------
alter table public.clips add column if not exists format text not null default 'short' check (format in ('short', 'longform'));

-- ---------------------------------------------------------------------------
-- videos.streamer_name — nome/handle da mostrare nella card dei crediti iniziale/finale dei
-- longform (ignorato per gli Short). Popolato alla creazione del progetto da chi ha scelto il
-- VOD nella Feed Twitch, non recuperato a runtime dal worker.
-- ---------------------------------------------------------------------------
alter table public.videos add column if not exists streamer_name text;

-- ---------------------------------------------------------------------------
-- projects.source_type — aggiunge 'twitch_vod' alle sorgenti valide (prima solo 'upload' e
-- 'youtube_url'). Postgres nomina il check inline della create table con la convenzione
-- <tabella>_<colonna>_check, quindi va sostituito esplicitamente per allargarlo.
-- ---------------------------------------------------------------------------
alter table public.projects drop constraint if exists projects_source_type_check;
alter table public.projects add constraint projects_source_type_check check (source_type in ('upload', 'youtube_url', 'twitch_vod'));

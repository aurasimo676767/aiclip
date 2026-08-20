-- ClipForge — schema iniziale (Fase 1)
-- Da eseguire nel SQL editor del progetto Supabase, oppure via `supabase db push`
-- se usi la Supabase CLI collegata al progetto.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles — estende auth.users con piano, crediti e contatori di utilizzo
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  plan text not null default 'FREE' check (plan in ('FREE', 'PRO', 'BUSINESS')),
  credits integer not null default 0,
  processing_minutes_used numeric not null default 0,
  storage_used_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Crea automaticamente una riga profiles quando un nuovo utente si registra.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  status text not null default 'UPLOADING'
    check (status in ('UPLOADING', 'UPLOADED', 'EXTRACTING_AUDIO', 'TRANSCRIBING', 'ANALYZING', 'CLIP_SELECTION', 'READY', 'FAILED')),
  source_type text not null check (source_type in ('upload', 'youtube_url')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_id_idx on public.projects (user_id);

-- ---------------------------------------------------------------------------
-- videos — file sorgente (uno per project in Fase 1)
-- ---------------------------------------------------------------------------
create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  storage_path text,
  original_filename text not null,
  source_url text,
  duration_seconds numeric,
  size_bytes bigint,
  mime_type text,
  status text not null default 'UPLOADING'
    check (status in ('UPLOADING', 'UPLOADED', 'EXTRACTING_AUDIO', 'TRANSCRIBING', 'ANALYZING', 'CLIP_SELECTION', 'READY', 'FAILED')),
  error_message text,
  -- claim lease per la coda di elaborazione (SKIP LOCKED + timeout)
  claimed_by text,
  claimed_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists videos_project_id_idx on public.videos (project_id);
create index if not exists videos_status_idx on public.videos (status);

-- ---------------------------------------------------------------------------
-- transcripts
-- ---------------------------------------------------------------------------
create table if not exists public.transcripts (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null unique references public.videos (id) on delete cascade,
  language text not null default 'en',
  duration_seconds numeric not null,
  full_text text not null,
  segments jsonb not null,
  provider text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- clips — clip suggerite dall'AI (e successivamente renderizzate)
-- ---------------------------------------------------------------------------
create table if not exists public.clips (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  video_id uuid not null references public.videos (id) on delete cascade,
  start_time numeric not null,
  end_time numeric not null,
  duration numeric not null,
  title text not null,
  hook text not null,
  reason text not null,
  scores jsonb not null,
  editing_style text not null,
  template text not null,
  edl jsonb not null,
  status text not null default 'SUGGESTED'
    check (status in ('SUGGESTED', 'QUEUED', 'RENDERING', 'COMPLETED', 'FAILED')),
  output_video_path text,
  thumbnail_path text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists clips_project_id_idx on public.clips (project_id);
create index if not exists clips_video_id_idx on public.clips (video_id);

-- ---------------------------------------------------------------------------
-- render_jobs — un job per ogni richiesta di render di una clip
-- ---------------------------------------------------------------------------
create table if not exists public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips (id) on delete cascade,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'RENDERING', 'COMPLETED', 'FAILED')),
  stage text,
  progress numeric not null default 0,
  attempts integer not null default 0,
  error_message text,
  claimed_by text,
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists render_jobs_clip_id_idx on public.render_jobs (clip_id);
create index if not exists render_jobs_status_idx on public.render_jobs (status);

-- ---------------------------------------------------------------------------
-- subscriptions — solo schema, nessun billing provider collegato in Fase 1
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  plan text not null default 'FREE' check (plan in ('FREE', 'PRO', 'BUSINESS')),
  status text not null default 'active',
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_id_idx on public.subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- usage — contatori aggregati per periodo, usati per applicare i limiti di piano
-- ---------------------------------------------------------------------------
create table if not exists public.usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  minutes_processed numeric not null default 0,
  clips_generated integer not null default 0,
  storage_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, period_start)
);

-- ---------------------------------------------------------------------------
-- updated_at automatico
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'projects', 'videos', 'clips', 'subscriptions', 'usage']
  loop
    execute format(
      'drop trigger if exists set_updated_at on public.%I; create trigger set_updated_at before update on public.%I for each row execute procedure public.set_updated_at();',
      t, t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.videos enable row level security;
alter table public.transcripts enable row level security;
alter table public.clips enable row level security;
alter table public.render_jobs enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage enable row level security;

-- profiles: l'utente vede e aggiorna solo la propria riga
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- projects: CRUD limitato al proprietario
create policy "projects_select_own" on public.projects for select using (auth.uid() = user_id);
create policy "projects_insert_own" on public.projects for insert with check (auth.uid() = user_id);
create policy "projects_update_own" on public.projects for update using (auth.uid() = user_id);
create policy "projects_delete_own" on public.projects for delete using (auth.uid() = user_id);

-- videos: accesso tramite ownership del project collegato
create policy "videos_select_own" on public.videos for select
  using (exists (select 1 from public.projects p where p.id = videos.project_id and p.user_id = auth.uid()));
create policy "videos_insert_own" on public.videos for insert
  with check (exists (select 1 from public.projects p where p.id = videos.project_id and p.user_id = auth.uid()));
create policy "videos_update_own" on public.videos for update
  using (exists (select 1 from public.projects p where p.id = videos.project_id and p.user_id = auth.uid()));

-- transcripts: sola lettura per il proprietario del video/project collegato
create policy "transcripts_select_own" on public.transcripts for select
  using (exists (
    select 1 from public.videos v
    join public.projects p on p.id = v.project_id
    where v.id = transcripts.video_id and p.user_id = auth.uid()
  ));

-- clips: accesso tramite ownership del project collegato
create policy "clips_select_own" on public.clips for select
  using (exists (select 1 from public.projects p where p.id = clips.project_id and p.user_id = auth.uid()));
create policy "clips_update_own" on public.clips for update
  using (exists (select 1 from public.projects p where p.id = clips.project_id and p.user_id = auth.uid()));

-- render_jobs: accesso tramite ownership della clip -> project collegati
create policy "render_jobs_select_own" on public.render_jobs for select
  using (exists (
    select 1 from public.clips c
    join public.projects p on p.id = c.project_id
    where c.id = render_jobs.clip_id and p.user_id = auth.uid()
  ));
create policy "render_jobs_insert_own" on public.render_jobs for insert
  with check (exists (
    select 1 from public.clips c
    join public.projects p on p.id = c.project_id
    where c.id = render_jobs.clip_id and p.user_id = auth.uid()
  ));

-- subscriptions / usage: sola lettura per il proprietario
create policy "subscriptions_select_own" on public.subscriptions for select using (auth.uid() = user_id);
create policy "usage_select_own" on public.usage for select using (auth.uid() = user_id);

-- Nota: il worker (apps/worker) usa la SUPABASE_SERVICE_ROLE_KEY, che bypassa
-- sempre la RLS. Le policy sopra proteggono esclusivamente l'accesso diretto
-- dal client web (browser) autenticato con la anon key + sessione utente.

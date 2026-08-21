-- ClipForge — pubblicazione automatica su YouTube (connessione OAuth per utente + coda di
-- pubblicazione, stesso pattern già usato per render_jobs).

-- ---------------------------------------------------------------------------
-- youtube_connections — un account YouTube collegato per utente (Fase 1: uno solo)
-- ---------------------------------------------------------------------------
create table if not exists public.youtube_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  channel_id text not null,
  channel_title text not null,
  scope text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.youtube_connections;
create trigger set_updated_at before update on public.youtube_connections
  for each row execute procedure public.set_updated_at();

alter table public.youtube_connections enable row level security;

create policy "youtube_connections_select_own" on public.youtube_connections for select using (auth.uid() = user_id);
create policy "youtube_connections_insert_own" on public.youtube_connections for insert with check (auth.uid() = user_id);
create policy "youtube_connections_update_own" on public.youtube_connections for update using (auth.uid() = user_id);
create policy "youtube_connections_delete_own" on public.youtube_connections for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- youtube_publish_jobs — coda di pubblicazione, una riga per richiesta di upload
-- ---------------------------------------------------------------------------
create table if not exists public.youtube_publish_jobs (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips (id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING', 'UPLOADING', 'COMPLETED', 'FAILED')),
  title text not null,
  description text not null,
  tags jsonb not null default '[]'::jsonb,
  privacy_status text not null default 'public' check (privacy_status in ('public', 'unlisted', 'private')),
  youtube_video_id text,
  youtube_url text,
  error_message text,
  claimed_by text,
  claimed_at timestamptz,
  attempts integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists youtube_publish_jobs_clip_id_idx on public.youtube_publish_jobs (clip_id);
create index if not exists youtube_publish_jobs_status_idx on public.youtube_publish_jobs (status);

alter table public.youtube_publish_jobs enable row level security;

create policy "youtube_publish_jobs_select_own" on public.youtube_publish_jobs for select
  using (exists (
    select 1 from public.clips c
    join public.projects p on p.id = c.project_id
    where c.id = youtube_publish_jobs.clip_id and p.user_id = auth.uid()
  ));
create policy "youtube_publish_jobs_insert_own" on public.youtube_publish_jobs for insert
  with check (exists (
    select 1 from public.clips c
    join public.projects p on p.id = c.project_id
    where c.id = youtube_publish_jobs.clip_id and p.user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- clips.hashtags — suggeriti dall'AI nello stesso passaggio di ranking (nessuna chiamata extra)
-- ---------------------------------------------------------------------------
alter table public.clips add column if not exists hashtags jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- claim_next_publish_job — stesso pattern di claim_next_render_job (0002_queue_functions.sql)
-- ---------------------------------------------------------------------------
create or replace function public.claim_next_publish_job(
  p_worker_id text,
  p_stale_seconds integer default 1800,
  p_max_attempts integer default 3
)
returns public.youtube_publish_jobs
language plpgsql
security definer set search_path = public
as $$
declare
  result public.youtube_publish_jobs;
  target_id uuid;
begin
  update public.youtube_publish_jobs
  set status = 'FAILED',
      error_message = coalesce(error_message, 'Job bloccato: numero massimo di tentativi superato'),
      claimed_by = null,
      claimed_at = null,
      completed_at = now()
  where status not in ('COMPLETED', 'FAILED')
    and claimed_at is not null
    and claimed_at < now() - make_interval(secs => p_stale_seconds)
    and attempts >= p_max_attempts;

  select id into target_id
  from public.youtube_publish_jobs
  where (
      (status = 'PENDING' and claimed_at is null)
      or (
        status not in ('COMPLETED', 'FAILED')
        and claimed_at is not null
        and claimed_at < now() - make_interval(secs => p_stale_seconds)
        and attempts < p_max_attempts
      )
    )
  order by created_at asc
  for update skip locked
  limit 1;

  if target_id is null then
    return null;
  end if;

  update public.youtube_publish_jobs
  set claimed_by = p_worker_id,
      claimed_at = now(),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now())
  where id = target_id
  returning * into result;

  return result;
end;
$$;

grant execute on function public.claim_next_publish_job(text, integer, integer) to service_role;

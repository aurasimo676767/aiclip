-- ClipForge — generazione automatica di copertine YouTube per video long-form già pubblicati.
-- L'utente incolla il link YouTube del proprio video pubblicato; il worker lo ricollega alla
-- clip corrispondente (via youtube_publish_jobs.youtube_url), estrae fotogrammi dal file
-- renderizzato già in R2, chiede a Claude (visione) di scegliere il migliore + scrivere il
-- titolo ad effetto, toglie lo sfondo dalla faccia scelta (in locale, node), compone il
-- risultato e lo carica come nuova copertina — anche direttamente su YouTube via API.
create table if not exists public.thumbnail_jobs (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips (id) on delete cascade,
  youtube_url text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  result_storage_path text,
  youtube_thumbnail_set boolean not null default false,
  error_message text,
  claimed_by text,
  claimed_at timestamptz,
  attempts integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists thumbnail_jobs_clip_id_idx on public.thumbnail_jobs (clip_id);
create index if not exists thumbnail_jobs_status_idx on public.thumbnail_jobs (status);

alter table public.thumbnail_jobs enable row level security;

create policy "thumbnail_jobs_select_own" on public.thumbnail_jobs for select
  using (exists (
    select 1 from public.clips c
    join public.projects p on p.id = c.project_id
    where c.id = thumbnail_jobs.clip_id and p.user_id = auth.uid()
  ));
create policy "thumbnail_jobs_insert_own" on public.thumbnail_jobs for insert
  with check (exists (
    select 1 from public.clips c
    join public.projects p on p.id = c.project_id
    where c.id = thumbnail_jobs.clip_id and p.user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- claim_next_thumbnail_job — reclama il prossimo job pronto per l'elaborazione
-- ---------------------------------------------------------------------------
create or replace function public.claim_next_thumbnail_job(
  p_worker_id text,
  p_stale_seconds integer default 900,
  p_max_attempts integer default 3
)
returns public.thumbnail_jobs
language plpgsql
security definer set search_path = public
as $$
declare
  result public.thumbnail_jobs;
  target_id uuid;
begin
  update public.thumbnail_jobs
  set status = 'FAILED',
      error_message = coalesce(error_message, 'Job bloccato: numero massimo di tentativi superato'),
      claimed_by = null,
      claimed_at = null
  where status = 'PROCESSING'
    and claimed_at is not null
    and claimed_at < now() - make_interval(secs => p_stale_seconds)
    and attempts >= p_max_attempts;

  select id into target_id
  from public.thumbnail_jobs
  where (
      (status = 'PENDING' and claimed_at is null)
      or (
        status = 'PROCESSING'
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

  update public.thumbnail_jobs
  set status = 'PROCESSING',
      claimed_by = p_worker_id,
      claimed_at = now(),
      started_at = coalesce(started_at, now()),
      attempts = attempts + 1
  where id = target_id
  returning * into result;

  return result;
end;
$$;

grant execute on function public.claim_next_thumbnail_job(text, integer, integer) to service_role;

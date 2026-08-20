-- ClipForge — funzioni di coda basate su Postgres (SELECT ... FOR UPDATE SKIP LOCKED)
--
-- PostgREST (l'API usata dal client supabase-js) non espone FOR UPDATE SKIP LOCKED,
-- quindi il claim atomico dei job è implementato come funzione SQL SECURITY DEFINER,
-- chiamata dal worker via `supabase.rpc(...)`. Questo evita di dover aprire una
-- connessione Postgres diretta (pg/DATABASE_URL) solo per il claim, mantenendo il
-- worker su un unico client (service role di supabase-js).
--
-- Ogni funzione gestisce anche il recupero dei job "bloccati": un job claimato ma
-- mai completato entro p_stale_seconds viene ri-assegnato; se ha già raggiunto
-- p_max_attempts viene marcato FAILED invece di essere ri-accodato all'infinito.

-- ---------------------------------------------------------------------------
-- claim_next_video — reclama il prossimo video pronto per la pipeline di analisi
-- ---------------------------------------------------------------------------
create or replace function public.claim_next_video(
  p_worker_id text,
  p_stale_seconds integer default 900,
  p_max_attempts integer default 3
)
returns public.videos
language plpgsql
security definer set search_path = public
as $$
declare
  result public.videos;
  target_id uuid;
begin
  -- Marca come FAILED i job bloccati che hanno esaurito i tentativi.
  update public.videos
  set status = 'FAILED',
      error_message = coalesce(error_message, 'Job bloccato: numero massimo di tentativi superato'),
      claimed_by = null,
      claimed_at = null
  where status not in ('READY', 'FAILED')
    and claimed_at is not null
    and claimed_at < now() - make_interval(secs => p_stale_seconds)
    and attempts >= p_max_attempts;

  select id into target_id
  from public.videos
  where (
      (status = 'UPLOADED' and claimed_at is null)
      or (
        status not in ('READY', 'FAILED')
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

  update public.videos
  set claimed_by = p_worker_id,
      claimed_at = now(),
      attempts = attempts + 1
  where id = target_id
  returning * into result;

  return result;
end;
$$;

grant execute on function public.claim_next_video(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- claim_next_render_job — reclama il prossimo job di render di una clip
-- ---------------------------------------------------------------------------
create or replace function public.claim_next_render_job(
  p_worker_id text,
  p_stale_seconds integer default 1800,
  p_max_attempts integer default 3
)
returns public.render_jobs
language plpgsql
security definer set search_path = public
as $$
declare
  result public.render_jobs;
  target_id uuid;
begin
  update public.render_jobs
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
  from public.render_jobs
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

  update public.render_jobs
  set claimed_by = p_worker_id,
      claimed_at = now(),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now())
  where id = target_id
  returning * into result;

  return result;
end;
$$;

grant execute on function public.claim_next_render_job(text, integer, integer) to service_role;

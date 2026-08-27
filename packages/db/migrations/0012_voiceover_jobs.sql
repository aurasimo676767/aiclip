-- Flusso separato dalla pipeline principale (nessuna AI, nessuna analisi): l'utente carica una
-- clip già pronta + un file audio (voice over) e il worker genera uno Short verticale con la
-- clip croppata a piena larghezza, l'audio del voice over al posto di quello originale, e
-- sottotitoli parola-per-parola trascritti dal voice over stesso.
create table if not exists public.voiceover_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  video_storage_path text,
  video_original_filename text not null,
  video_mime_type text not null,
  audio_storage_path text,
  audio_original_filename text not null,
  status text not null default 'UPLOADING'
    check (status in ('UPLOADING', 'PENDING', 'RENDERING', 'COMPLETED', 'FAILED')),
  output_video_path text,
  error_message text,
  claimed_by text,
  claimed_at timestamptz,
  attempts integer not null default 0,
  cancel_requested boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists voiceover_jobs_user_id_idx on public.voiceover_jobs (user_id);
create index if not exists voiceover_jobs_status_idx on public.voiceover_jobs (status);

drop trigger if exists set_updated_at on public.voiceover_jobs;
create trigger set_updated_at before update on public.voiceover_jobs for each row execute procedure public.set_updated_at();

alter table public.voiceover_jobs enable row level security;

create policy "voiceover_jobs_select_own" on public.voiceover_jobs for select using (auth.uid() = user_id);
create policy "voiceover_jobs_insert_own" on public.voiceover_jobs for insert with check (auth.uid() = user_id);
create policy "voiceover_jobs_update_own" on public.voiceover_jobs for update using (auth.uid() = user_id);
create policy "voiceover_jobs_delete_own" on public.voiceover_jobs for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- claim_next_voiceover_job — reclama il prossimo job voice-over pronto per il render
-- ---------------------------------------------------------------------------
create or replace function public.claim_next_voiceover_job(
  p_worker_id text,
  p_stale_seconds integer default 1800,
  p_max_attempts integer default 3
)
returns public.voiceover_jobs
language plpgsql
security definer set search_path = public
as $$
declare
  result public.voiceover_jobs;
  target_id uuid;
begin
  update public.voiceover_jobs
  set status = 'FAILED',
      error_message = coalesce(error_message, 'Job bloccato: numero massimo di tentativi superato'),
      claimed_by = null,
      claimed_at = null
  where status not in ('COMPLETED', 'FAILED')
    and status != 'UPLOADING'
    and claimed_at is not null
    and claimed_at < now() - make_interval(secs => p_stale_seconds)
    and attempts >= p_max_attempts;

  select id into target_id
  from public.voiceover_jobs
  where (
      (status = 'PENDING' and claimed_at is null)
      or (
        status not in ('COMPLETED', 'FAILED')
        and status != 'UPLOADING'
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

  update public.voiceover_jobs
  set status = 'RENDERING',
      claimed_by = p_worker_id,
      claimed_at = now(),
      attempts = attempts + 1
  where id = target_id
  returning * into result;

  return result;
end;
$$;

grant execute on function public.claim_next_voiceover_job(text, integer, integer) to service_role;

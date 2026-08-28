-- ClipForge — claim_next_video considerava un video "bloccato" dopo soli 15 minuti (900s,
-- ragionevole per un video breve pre-longform) e lo riassegnava a un nuovo tentativo anche se il
-- worker originale ci stava ancora lavorando attivamente — per un VOD Twitch di ore, estrazione
-- audio + trascrizione da sole durano facilmente più di 15 minuti, quindi il job si "rubava" da
-- solo il proprio lavoro in corso, ripartendo sempre da capo (osservato in pratica: un VOD di
-- 7h45m tornava all'estrazione audio dopo ~15 min di trascrizione già in corso, in loop).
-- Alzato a 3 ore: abbastanza generoso per anche i VOD più lunghi, ma un worker davvero morto
-- (crash, kill) viene comunque recuperato entro un tempo ragionevole.
create or replace function public.claim_next_video(
  p_worker_id text,
  p_stale_seconds integer default 10800,
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

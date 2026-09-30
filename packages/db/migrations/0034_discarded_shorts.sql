-- Shorts che l'AI ha trovato ma scartato, con il motivo: sul sito simo li vede e può recuperarli
-- (simo, 2026-09-30). Ogni elemento: { reason, row } dove row è la clip pronta da inserire.
alter table public.videos add column if not exists discarded_shorts jsonb;

-- Recuperare uno Short scartato crea la clip dal sito.
drop policy if exists "clips_insert_own" on public.clips;
create policy "clips_insert_own" on public.clips for insert
  with check (exists (select 1 from public.projects p where p.id = clips.project_id and p.user_id = auth.uid()));

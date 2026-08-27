-- Permette di annullare una pubblicazione YouTube GIÀ CARICATA (privata, in attesa che YouTube
-- la renda pubblica da sola a publish_at) senza toccare lo status esistente (COMPLETED resta
-- vero: l'upload è davvero riuscito) — cancelled_at distingue "caricato e ancora programmato"
-- da "caricato ma l'utente ha annullato la programmazione" (il video resta privato su YouTube).
alter table public.youtube_publish_jobs add column if not exists cancelled_at timestamptz;

-- Mancava una policy di update (finora solo il worker, con la service role che bypassa RLS,
-- scriveva su questa tabella): il pulsante "Annulla programmazione" scrive invece con la
-- sessione dell'utente, stessa ownership-chain già usata da youtube_publish_jobs_select_own.
create policy "youtube_publish_jobs_update_own" on public.youtube_publish_jobs for update
  using (exists (
    select 1 from public.clips c
    join public.projects p on p.id = c.project_id
    where c.id = youtube_publish_jobs.clip_id and p.user_id = auth.uid()
  ));

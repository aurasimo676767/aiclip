-- Permette all'utente di annullare manualmente un video/progetto o un render in corso dalla
-- dashboard. cancel_requested è il segnale che il worker controlla tra uno stadio e l'altro
-- della pipeline per interrompersi appena possibile (non può interrompere una singola chiamata
-- già in volo, es. una trascrizione whisper o un render ffmpeg già avviati, ma evita di
-- sprecare gli stadi successivi, in genere i più costosi).
alter table public.videos add column if not exists cancel_requested boolean not null default false;
alter table public.render_jobs add column if not exists cancel_requested boolean not null default false;

-- Mancava una policy di update per render_jobs (finora solo il worker, con la service role che
-- bypassa RLS, scriveva su questa tabella): il pulsante "Annulla" scrive invece con la sessione
-- dell'utente, stessa ownership-chain già usata da render_jobs_select_own.
create policy "render_jobs_update_own" on public.render_jobs for update
  using (
    exists (
      select 1 from public.clips c join public.projects p on p.id = c.project_id
      where c.id = render_jobs.clip_id and p.user_id = auth.uid()
    )
  );

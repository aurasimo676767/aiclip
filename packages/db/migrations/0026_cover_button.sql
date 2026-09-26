-- ClipForge — pulsante "Genera copertina" su ogni video (long-form e Shorts), chiesto da simo il
-- 2026-09-26: la copertina non si genera più in automatico né si carica subito su YouTube.
-- 1) Si genera un'anteprima (thumbnail_jobs senza link YouTube).
-- 2) Se piace, "Carica": il sito segna apply_requested e rimette il job in coda; il worker la
--    imposta sul video se è già pubblicato, e comunque la salva in clips.cover_path così la
--    pubblicazione la usa appena il video va su YouTube.
-- 3) Se non piace, "Rigenera" crea un nuovo job.

alter table public.thumbnail_jobs alter column youtube_url drop not null;
alter table public.thumbnail_jobs add column if not exists apply_requested boolean not null default false;

-- Copertina approvata dall'utente (percorso su R2): la usa la pubblicazione su YouTube.
alter table public.clips add column if not exists cover_path text;

-- Il sito aggiorna solo i job delle proprie clip (per chiedere il caricamento).
drop policy if exists "thumbnail_jobs_update_own" on public.thumbnail_jobs;
create policy "thumbnail_jobs_update_own" on public.thumbnail_jobs for update
  using (exists (
    select 1 from public.clips c
    join public.projects p on p.id = c.project_id
    where c.id = thumbnail_jobs.clip_id and p.user_id = auth.uid()
  ));

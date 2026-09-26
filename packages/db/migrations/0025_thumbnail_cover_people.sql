-- Persone scelte a mano per una copertina (es. {BLUR,MARZA}): nella copertina ci sono solo loro,
-- nell'ordine indicato (il primo è il protagonista). NULL = le prende il worker dal titolo del video.
-- Vedi apps/worker/src/pipeline/process-thumbnail-job.ts e la libreria delle facce su R2.
alter table public.thumbnail_jobs add column if not exists cover_people text[];

comment on column public.thumbnail_jobs.cover_people is
  'Nomi (maiuscolo) delle persone da mettere in copertina, il primo è il protagonista. NULL = dedotte dal titolo.';

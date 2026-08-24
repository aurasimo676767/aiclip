-- ClipForge — pubblicazione programmata su YouTube: l'upload avviene subito (serve il worker
-- acceso), ma il video resta privato fino a publish_at, quando YouTube stessa lo rende
-- pubblico da sola (status.publishAt nativo dell'API, nessun scheduler nostro necessario).
alter table public.youtube_publish_jobs add column if not exists publish_at timestamptz;

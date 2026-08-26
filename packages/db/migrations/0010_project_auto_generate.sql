-- Flag impostato dall'import bulk ("Genera più video"): quando true, il worker mette in coda
-- il render di TUTTE le clip suggerite non appena pronte, senza aspettare una selezione manuale.
alter table public.projects add column if not exists auto_generate_clips boolean not null default false;

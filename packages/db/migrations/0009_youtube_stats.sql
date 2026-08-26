-- Statistiche YouTube (views/like/commenti) salvate periodicamente dal worker invece di
-- essere lette live ad ogni apertura della pagina — vedi apps/worker/src/pipeline/refresh-youtube-stats.ts.
alter table public.youtube_publish_jobs add column if not exists view_count bigint;
alter table public.youtube_publish_jobs add column if not exists like_count bigint;
alter table public.youtube_publish_jobs add column if not exists comment_count bigint;
alter table public.youtube_publish_jobs add column if not exists stats_updated_at timestamptz;

-- ClipForge — statistiche YouTube complete per ogni video pubblicato (chiesto da simo il
-- 2026-09-27: "le analytics sul sito, per ogni short"). Le legge il worker dall'API YouTube
-- Analytics (serve il permesso yt-analytics.readonly: ricollegare YouTube una volta). La tenuta
-- arriva da YouTube con 1-2 giorni di ritardo, views/like/commenti quasi in tempo reale.
-- "Ha continuato a guardare" (Studio) ≈ engaged_views / view_count.
alter table public.youtube_publish_jobs add column if not exists engaged_views integer;
alter table public.youtube_publish_jobs add column if not exists avg_view_duration numeric;
alter table public.youtube_publish_jobs add column if not exists avg_view_percentage numeric;
alter table public.youtube_publish_jobs add column if not exists share_count integer;
alter table public.youtube_publish_jobs add column if not exists subscribers_gained integer;
alter table public.youtube_publish_jobs add column if not exists analytics_views integer;
alter table public.youtube_publish_jobs add column if not exists analytics_updated_at timestamptz;
alter table public.youtube_publish_jobs add column if not exists analytics_error text;

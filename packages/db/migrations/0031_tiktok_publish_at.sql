-- Pubblicazione su TikTok programmata (tramite Zernio, che pubblica lui all'orario scelto).
-- null = subito. Chiesto da simo il 2026-09-29.
alter table public.tiktok_publish_jobs add column if not exists publish_at timestamptz;

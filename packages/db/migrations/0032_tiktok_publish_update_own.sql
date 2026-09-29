-- Il sito deve poter annullare la pubblicazione TikTok programmata insieme a quella YouTube
-- (tasto "Annulla programmazione"). Chiesto da simo il 2026-09-29.
create policy "tiktok_publish_jobs_update_own" on public.tiktok_publish_jobs for update using (auth.uid() = user_id);

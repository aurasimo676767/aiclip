-- ClipForge — login Twitch (handle esatto usato nell'URL, es. "tumblurr") dello streamer
-- originale di un video long-form, separato da streamer_name (nome visualizzato, può differire
-- da handle/maiuscole). Serve per costruire il link corretto al canale nel preset di descrizione
-- di pubblicazione YouTube (vedi apps/web/src/lib/data/clips.ts), invece di doverlo indovinare
-- da streamer_name.
alter table public.videos add column if not exists streamer_login text;

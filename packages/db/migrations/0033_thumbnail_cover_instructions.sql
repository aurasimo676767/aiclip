-- Istruzioni libere per l'AI della copertina (che gioco è, quali e quante scritte, stile...):
-- vincono sulle regole standard. null = fa tutto l'AI. Chiesto da simo il 2026-09-29.
alter table public.thumbnail_jobs add column if not exists cover_instructions text;

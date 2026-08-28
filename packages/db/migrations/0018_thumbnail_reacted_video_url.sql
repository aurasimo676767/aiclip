-- ClipForge — link opzionale al video ORIGINALE reagito, incollato a mano dall'utente quando lo
-- conosce: la ricerca automatica (l'IA legge titolo/canale dai fotogrammi) a volte non trova
-- nulla o trova il video sbagliato — con questo campo si scavalca del tutto l'indovinello e si
-- prende la copertina vera direttamente da quel link.
alter table public.thumbnail_jobs add column if not exists reacted_video_url text;

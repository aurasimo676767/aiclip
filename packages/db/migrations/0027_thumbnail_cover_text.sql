-- ClipForge — scritta della copertina scelta a mano dal riquadro "Copertina" (facoltativa): vince
-- su quella scelta dall'AI. Serve anche quando GPT rifiuta un argomento delicato: si può
-- riprovare con parole diverse.
alter table public.thumbnail_jobs add column if not exists cover_text text;

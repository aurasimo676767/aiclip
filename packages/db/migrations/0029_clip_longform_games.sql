-- Giochi di una clip long-form riconosciuti dallo SCHERMO (vedi
-- apps/worker/src/providers/ai/game-timeline.ts) e quali tenere nel video montato. Chiesto da simo
-- il 2026-09-28: in una clip di un'ora possono esserci 2-3 giochi, e decide lui quale lasciare.
alter table public.clips add column if not exists longform_games jsonb;
alter table public.clips add column if not exists longform_keep_games text[];

comment on column public.clips.longform_games is
  'Solo long-form: [{start, end, kind: gioco|ruota|altro, name, what?}] in secondi dall''inizio della clip. null = non ancora riconosciuti.';
comment on column public.clips.longform_keep_games is
  'Solo long-form montato: nomi dei giochi da tenere (anche "Altro"). null = il gioco che dura di più.';

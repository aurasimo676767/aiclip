-- Titolo e descrizione di una clip venivano scritti una volta sola dall'IA e non erano modificabili
-- da nessuna parte: chi usa la programmazione automatica si ritrovava quindi il video pubblicato
-- con il testo generato, senza poterlo correggere prima. Il titolo era gia' su clips.title (basta
-- scriverci sopra), la descrizione invece no: per le clip long-form la descrizione pubblicata non
-- e' clips.caption ma un preset fisso di crediti allo streamer, calcolato al volo, quindi non
-- esisteva nessun campo su cui salvare una versione scritta a mano.
alter table public.clips add column if not exists publish_description text;

comment on column public.clips.publish_description is
  'Descrizione scritta a mano dall''utente, se presente vince sia sul preset long-form sia su caption. NULL = usa il testo generato automaticamente.';

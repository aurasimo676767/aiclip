-- Montaggio automatico dei video long-form (taglio dei tempi morti + stacco sulla faccia di chi
-- urla), vedi apps/worker/src/render/longform-auto-edit.ts. Spento di default: senza, il video
-- long-form resta il semplice taglio di sempre (copia diretta, nessuna ricodifica).
alter table public.clips add column if not exists longform_edit boolean not null default false;

comment on column public.clips.longform_edit is
  'Solo long-form: true = al render il worker taglia i tempi morti e fa gli stacchi sulle urla. false = solo taglio.';

-- ClipForge — statistiche reali (non stimate) di uso AI e tempi di elaborazione per video: token
-- input/output per modello (haiku/sonnet), costo in $ calcolato dal worker sui prezzi correnti, e
-- durata di ogni fase della pipeline (download, trascrizione, analisi AI). Popolato dal worker a
-- fine pipeline (vedi apps/worker/src/pipeline/process-video-job.ts), letto dal sito per mostrare
-- all'utente quanto è costata/durata davvero l'elaborazione di un video — nato dalla richiesta di
-- confrontare una previsione di costo col consumo reale su un VOD lungo.
alter table public.videos add column if not exists usage_stats jsonb;

comment on column public.videos.usage_stats is
  'Statistiche reali di uso AI/tempi per questo video: {tokens: {haiku: {input,output,calls}, sonnet: {...}}, costUsd: {haiku, sonnet, total}, stages: {downloadSeconds, transcriptionSeconds, aiAnalysisSeconds}}. Null se il video non è mai stato elaborato con questa versione del worker.';

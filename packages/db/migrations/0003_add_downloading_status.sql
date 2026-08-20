-- ClipForge — aggiunge lo stato DOWNLOADING (import da URL YouTube) alla pipeline.
-- Va tra UPLOADED e EXTRACTING_AUDIO: il worker lo usa mentre scarica il video da YouTube
-- (via yt-dlp) prima di caricarlo su Storage e proseguire con la pipeline esistente.

alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects add constraint projects_status_check
  check (status in ('UPLOADING', 'UPLOADED', 'DOWNLOADING', 'EXTRACTING_AUDIO', 'TRANSCRIBING', 'ANALYZING', 'CLIP_SELECTION', 'READY', 'FAILED'));

alter table public.videos drop constraint if exists videos_status_check;
alter table public.videos add constraint videos_status_check
  check (status in ('UPLOADING', 'UPLOADED', 'DOWNLOADING', 'EXTRACTING_AUDIO', 'TRANSCRIBING', 'ANALYZING', 'CLIP_SELECTION', 'READY', 'FAILED'));

-- L'upload da file resta obbligatorio con storage_path valorizzato entro la fine
-- dell'upload; per l'import da YouTube invece storage_path parte NULL e source_url
-- valorizzato — nessuna modifica di schema necessaria, già supportato da 0001_init.sql.

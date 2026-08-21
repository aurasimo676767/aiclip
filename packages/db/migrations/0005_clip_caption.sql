-- ClipForge — didascalia pubblica generata dall'AI (separata da "reason", che resta interna).
alter table public.clips add column if not exists caption text not null default '';

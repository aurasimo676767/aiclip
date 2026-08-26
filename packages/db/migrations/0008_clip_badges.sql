alter table public.clips add column if not exists badges jsonb not null default '[]'::jsonb;

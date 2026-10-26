-- Stile dei sottotitoli scelto per ogni Short e preset personali con nome (simo, 2026-10-26: l'editor
-- sceglie lo stile per il singolo Short vedendolo dal vivo sul video, e può salvare preset suoi).

-- Preset personali: un nome e le impostazioni (vedi CaptionSettings in packages/shared).
create table if not exists public.caption_presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  settings jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists caption_presets_user_idx on public.caption_presets (user_id, created_at);
alter table public.caption_presets enable row level security;
drop policy if exists "caption_presets_own" on public.caption_presets;
create policy "caption_presets_own" on public.caption_presets for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Per ogni Short: lo stile scelto (null = lo stile di partenza), il video SENZA sottotitoli su cui il
-- sito disegna l'anteprima dal vivo, le parole con i loro tempi per quell'anteprima, e la "regia"
-- già calcolata (inquadrature + regia del gioco) per rifare il render cambiando solo lo stile senza
-- richiamare l'AI.
alter table public.clips add column if not exists caption_settings jsonb;
alter table public.clips add column if not exists preview_video_path text;
alter table public.clips add column if not exists caption_track_path text;
alter table public.clips add column if not exists render_plan jsonb;

-- Stile di partenza per i nuovi Shorts (null = "Classico").
alter table public.profiles add column if not exists default_caption_settings jsonb;

-- "captions" = cambia solo lo stile: riusa la regia salvata, nessuna chiamata AI.
alter table public.render_jobs add column if not exists mode text not null default 'full';
alter table public.render_jobs drop constraint if exists render_jobs_mode_check;
alter table public.render_jobs add constraint render_jobs_mode_check check (mode in ('full', 'captions'));

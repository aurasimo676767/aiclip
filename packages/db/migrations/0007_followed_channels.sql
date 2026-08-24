-- ClipForge — canali YouTube seguiti, per lo scan manuale di nuovi video da importare
-- automaticamente (stessa pipeline dell'import da URL singolo, nessuna logica nuova lato worker).
create table if not exists public.followed_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  channel_id text not null,
  channel_title text not null,
  uploads_playlist_id text not null,
  created_at timestamptz not null default now(),
  unique (user_id, channel_id)
);

alter table public.followed_channels enable row level security;

create policy "followed_channels_select_own" on public.followed_channels for select using (auth.uid() = user_id);
create policy "followed_channels_insert_own" on public.followed_channels for insert with check (auth.uid() = user_id);
create policy "followed_channels_delete_own" on public.followed_channels for delete using (auth.uid() = user_id);

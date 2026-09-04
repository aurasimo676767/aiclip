-- ClipForge — orari fissi di pubblicazione automatica, configurabili dall'utente e separati per
-- Shorts e long-form (prima era un intervallo random 2h-2h30 da "adesso", uguale per entrambi i
-- formati, non modificabile). Una riga per utente. Gli orari sono stringhe "HH:MM" (24h),
-- interpretate in Europe/Rome (vedi apps/web/src/lib/publish-schedule.ts, unica fonte di verità
-- per l'interpretazione del fuso — nessuna colonna qui, per ora un solo fuso per tutti gli utenti).
create table if not exists public.publish_schedules (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  short_times text[] not null default '{}',
  longform_times text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.publish_schedules;
create trigger set_updated_at before update on public.publish_schedules for each row execute procedure public.set_updated_at();

alter table public.publish_schedules enable row level security;

create policy "publish_schedules_select_own" on public.publish_schedules for select using (auth.uid() = user_id);
create policy "publish_schedules_insert_own" on public.publish_schedules for insert with check (auth.uid() = user_id);
create policy "publish_schedules_update_own" on public.publish_schedules for update using (auth.uid() = user_id);
create policy "publish_schedules_delete_own" on public.publish_schedules for delete using (auth.uid() = user_id);

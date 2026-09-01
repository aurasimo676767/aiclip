-- ClipForge — controllo pausa/ripresa del worker dal sito. Riga singola (pattern "singleton" via
-- chiave primaria booleana forzata a true): quando l'utente deve fare qualcosa di urgente sul PC
-- e il worker sta consumando troppe risorse (download/estrazione audio/trascrizione/render), può
-- mettere in pausa da qui — il worker sospende DAVVERO i processi pesanti (ffmpeg, yt-dlp, il
-- server whisper locale) a livello di sistema operativo, non solo "aspetta tra una fase e l'altra"
-- (che non aiuterebbe: il momento critico è proprio dentro una fase lunga).
create table if not exists public.worker_control (
  id boolean primary key default true,
  paused boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint worker_control_singleton check (id = true)
);

insert into public.worker_control (id, paused) values (true, false) on conflict (id) do nothing;

alter table public.worker_control enable row level security;

-- Nessuna nozione di "proprietario": è un controllo globale del worker locale, non per-utente.
-- Qualunque utente autenticato può leggerlo/scriverlo (coerente con l'uso: un solo operatore).
-- drop/create invece di "if not exists" (non supportato da CREATE POLICY) per poter rieseguire
-- questa migrazione senza errori se già applicata in parte.
drop policy if exists "worker_control_select_authenticated" on public.worker_control;
create policy "worker_control_select_authenticated" on public.worker_control for select using (auth.role() = 'authenticated');
drop policy if exists "worker_control_update_authenticated" on public.worker_control;
create policy "worker_control_update_authenticated" on public.worker_control for update using (auth.role() = 'authenticated');

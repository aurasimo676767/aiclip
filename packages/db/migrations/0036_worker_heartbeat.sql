-- Il sito deve sapere se il PC di simo è acceso (la Home mostra "Il PC adesso"): il worker aggiorna
-- questo orario ogni ~15 secondi. Più vecchio di un minuto = worker spento (2026-10-26: un amico aveva
-- messo uno Short da fare col worker spento e nessuno se n'era accorto).
alter table public.worker_control add column if not exists last_seen_at timestamptz;

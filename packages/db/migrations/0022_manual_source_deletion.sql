-- La cancellazione automatica del sorgente (quando tutte le clip di un video diventano terminali)
-- costringeva a un giro completo di ri-download da YouTube + ri-upload su R2 + ri-download locale
-- ogni volta che si tornava su un video "chiuso" per generare altre clip — osservato causare ore
-- di attesa non necessarie. Sostituita da un tasto manuale in dashboard: l'utente sceglie lui
-- quando liberare davvero lo spazio.
alter table public.videos add column if not exists delete_source_requested_at timestamptz;

comment on column public.videos.delete_source_requested_at is
  'Impostato dal tasto "Elimina sorgente" in dashboard: il worker cancella storage_path da R2 e la cache locale, poi azzera questo campo.';

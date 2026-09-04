// Un solo fuso per tutti gli utenti per ora (nessuna colonna di preferenza in DB) — l'utenza
// attuale è italiana, e Intl gestisce da solo il passaggio ora legale/solare.
const TIMEZONE = "Europe/Rome";
export const PUBLISH_SCHEDULE_TIMEZONE = TIMEZONE;

/** Differenza (in minuti) tra UTC e TIMEZONE per un istante dato, DST inclusa. */
function tzOffsetMinutes(date: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60000;
}

/** Istante UTC reale corrispondente a "oggi (visto in TIMEZONE) + dayOffset giorni, alle HH:MM in TIMEZONE". */
function slotDateTime(referenceUtc: Date, dayOffset: number, hhmm: string): Date {
  const [hh, mm] = hhmm.split(":").map(Number);
  const refParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(referenceUtc)
      .map((p) => [p.type, p.value]),
  );
  // Prima stima ingenua (come se TIMEZONE fosse UTC), poi corretta col vero offset di quella
  // data — evita di dover gestire a mano i cambi ora legale/solare.
  const naiveGuess = new Date(
    Date.UTC(Number(refParts.year), Number(refParts.month) - 1, Number(refParts.day) + dayOffset, hh, mm, 0),
  );
  return new Date(naiveGuess.getTime() - tzOffsetMinutes(naiveGuess) * 60000);
}

export interface PickNextFixedSlotsParams {
  /** Orari "HH:MM" (24h, TIMEZONE) — la griglia giornaliera fissa configurata dall'utente per questo formato. */
  times: string[];
  /** Quanti slot servono. */
  count: number;
  /** Slot futuri già occupati DA QUESTO STESSO FORMATO (altre clip già programmate) — non riassegnati. */
  existingFutureSlots: Date[];
  /** Solo per i test — default: adesso. */
  from?: Date;
}

/**
 * Assegna `count` slot ai prossimi orari liberi della griglia fissa `times`, camminando in avanti
 * giorno per giorno da `from` — riempie prima gli orari rimasti oggi, poi l'intera griglia di
 * domani, e così via, saltando gli orari già passati o già occupati.
 */
export function pickNextFixedSlots({ times, count, existingFutureSlots, from = new Date() }: PickNextFixedSlotsParams): Date[] {
  if (times.length === 0 || count <= 0) return [];

  const sortedTimes = [...times].sort();
  const occupied = new Set(existingFutureSlots.map((d) => d.getTime()));
  const result: Date[] = [];

  let dayOffset = 0;
  // 400 giorni come tetto di sicurezza contro un loop infinito (non dovrebbe mai servire con
  // sortedTimes non vuoto, ma meglio un limite esplicito che affidarsi solo alla condizione sopra).
  while (result.length < count && dayOffset < 400) {
    for (const t of sortedTimes) {
      const candidate = slotDateTime(from, dayOffset, t);
      if (candidate.getTime() <= from.getTime() || occupied.has(candidate.getTime())) continue;
      occupied.add(candidate.getTime());
      result.push(candidate);
      if (result.length === count) break;
    }
    dayOffset++;
  }

  return result;
}

/** Valida un orario "HH:MM" 24h (con zero iniziale su ore/minuti a una cifra). */
export function isValidTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

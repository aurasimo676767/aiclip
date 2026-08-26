/**
 * Mutex asincrono minimale: al massimo un `fn` alla volta, gli altri aspettano in fila (FIFO).
 * Usato per serializzare l'accesso a una risorsa condivisa non parallelizzabile (es. la GPU
 * della trascrizione locale) anche quando più job vengono processati in parallelo altrove
 * nella pipeline — vedi LocalFasterWhisperProvider.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}

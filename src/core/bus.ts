/** Minimal typed pub/sub used for engine events. */
export class Bus<E> {
  private readonly listeners = new Set<(e: E) => void>();

  on(fn: (e: E) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: E): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        // a faulty subscriber must not break the engine
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

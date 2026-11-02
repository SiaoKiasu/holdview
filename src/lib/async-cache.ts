// Short-lived process cache only: never a substitute for persistent storage.
export class AsyncCache<T> {
  private entries = new Map<string, { until: number; value?: T; pending?: Promise<T> }>();
  constructor(
    private ttl: number,
    private limit = 128,
  ) {}
  invalidate(key: string) {
    this.entries.delete(key);
  }
  async get(key: string, read: () => Promise<T>): Promise<T> {
    const current = this.entries.get(key);
    if (current?.pending) return structuredClone(await current.pending);
    if (current && current.until > Date.now()) return structuredClone(current.value!);
    const entry: { until: number; value?: T; pending?: Promise<T> } = { until: 0 };
    this.entries.delete(key);
    for (const [k, v] of this.entries)
      if (!v.pending && v.until <= Date.now()) this.entries.delete(k);
    while (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, entry);
    entry.pending = Promise.resolve()
      .then(read)
      .then((value) => {
        // An invalidation/write during the read must not resurrect old data.
        if (this.entries.get(key) === entry) {
          entry.value = structuredClone(value);
          entry.until = Date.now() + this.ttl;
          entry.pending = undefined;
        }
        return value;
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    return structuredClone(await entry.pending);
  }
}

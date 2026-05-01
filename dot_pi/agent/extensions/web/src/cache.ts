export class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private enabled: boolean,
    private ttlMs: number,
    private maxEntries: number,
  ) {}

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order for simple LRU behavior.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.enabled) return;
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

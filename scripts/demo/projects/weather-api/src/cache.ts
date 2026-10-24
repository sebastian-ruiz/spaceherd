export class Cache<T> {
  private entries = new Map<string, { value: T; expires: number }>();

  constructor(private ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expires < Date.now()) return undefined;
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

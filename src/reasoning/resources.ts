type Entry<T> = { value: T; bytes: number };

/** Disposable immutable-value cache. Eviction never deletes authoritative SQLite state. */
export class SizedHotCache<T> {
    private readonly entries = new Map<string, Entry<T>>();
    private bytes = 0;
    private readonly limit: number;
    constructor(limit: number) { this.limit = limit; }
    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }
    set(key: string, value: T, bytes: number): void {
        this.delete(key);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit) return;
        while (this.bytes + bytes > this.limit) this.delete(this.entries.keys().next().value!);
        this.entries.set(key, { value, bytes });
        this.bytes += bytes;
    }
    delete(key: string): void {
        const entry = this.entries.get(key);
        if (entry) this.bytes -= entry.bytes;
        this.entries.delete(key);
    }
    clear(): void { this.entries.clear(); this.bytes = 0; }
    get retainedBytes(): number { return this.bytes; }
}

export interface PersistedCacheEntry {
  key: string;
  value: string;
  expiresAt: number | null;
  willIds: string[];
}

export interface CachePersistenceAdapter {
  readAll(): Promise<PersistedCacheEntry[]>;
  write(entry: PersistedCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ReadCacheOptions {
  namespace?: string;
  ttlMs?: number;
  now?: () => number;
  persistence?: CachePersistenceAdapter;
}

interface CacheEntry {
  key: string;
  value: unknown;
  expiresAt: number | null;
  willIds: Set<string>;
}

const DEFAULT_CACHE_NAMESPACE = 'sorowill:read-cache';

function serializeCacheValue(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === 'bigint') {
      return { __type: 'bigint', value: currentValue.toString() };
    }
    return currentValue;
  });
}

function deserializeCacheValue<T>(value: string): T {
  return JSON.parse(value, (_key, currentValue) => {
    if (
      currentValue &&
      typeof currentValue === 'object' &&
      '__type' in currentValue &&
      currentValue.__type === 'bigint' &&
      'value' in currentValue &&
      typeof currentValue.value === 'string'
    ) {
      return BigInt(currentValue.value);
    }
    return currentValue;
  }) as T;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === 'bigint') {
      return { __type: 'bigint', value: currentValue.toString() };
    }

    if (Array.isArray(currentValue)) {
      return currentValue;
    }

    if (currentValue && typeof currentValue === 'object') {
      const sortedEntries = Object.entries(currentValue as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return Object.fromEntries(sortedEntries);
    }

    return currentValue;
  });
}

export function createReadCacheKey(method: string, args: Record<string, unknown>): string {
  return `${method}:${stableStringify(args)}`;
}

/**
 * A memory-backed read cache with optional persistent storage.
 *
 * IMPORTANT: If a persistence adapter is configured, hydration (loading stored
 * entries) happens asynchronously in the constructor. Callers must await
 * `cache.ready()` before calling `cache.get()` to ensure all persisted entries
 * are available. Calling `get()` before `ready()` completes will incorrectly
 * return a cache miss for data that is being loaded.
 *
 * Without persistence, the cache is immediately ready and can be used after
 * construction.
 */
export class ReadCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly persistence: CachePersistenceAdapter | undefined;
  private readonly readyPromise: Promise<void>;
  /**
   * Keys written or deleted after construction but before hydration completes.
   * Hydration must not overwrite these with older persisted values.
   */
  private readonly touchedKeys = new Set<string>();
  /**
   * Set when clear() is called before hydration completes. Hydration must not
   * repopulate the cache once it resolves.
   */
  private clearedBeforeHydration = false;

  constructor(options: ReadCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence;
    this.readyPromise = this.hydrate();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  /**
   * Synchronously retrieves a cached value by key.
   *
   * WARNING: If this cache was constructed with persistence enabled, you MUST
   * call and await `ready()` before calling this method. Calling `get()` before
   * `ready()` completes will return undefined for entries that are currently
   * being loaded from persistent storage.
   *
   * @param key - The cache key to look up
   * @returns The cached value if found and not expired, or undefined
   */
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  set(key: string, value: unknown, willIds: Iterable<string> = []): void {
    if (this.ttlMs === 0) {
      this.touchedKeys.add(key);
      void this.persistence?.delete(key);
      return;
    }

    const entry: CacheEntry = {
      key,
      value,
      expiresAt: this.ttlMs > 0 ? this.now() + this.ttlMs : null,
      willIds: new Set(willIds),
    };

    this.touchedKeys.add(key);
    this.entries.set(key, entry);
    void this.persistence
      ?.write(this.toPersistedEntry(entry))
      .catch(() => {
        // Silently ignore persistence failures to prevent unhandled rejections
        // The cache remains functional in-memory; only durability is lost
      });
  }

  async invalidateByWillId(willId: string): Promise<void> {
    await this.readyPromise;

    const keysToDelete: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.willIds.has(willId)) {
        keysToDelete.push(key);
      }
    }

    await Promise.all(keysToDelete.map((key) => this.delete(key)));
  }

  clear(): void {
    this.clearedBeforeHydration = true;
    this.entries.clear();
    void this.persistence?.clear().catch(() => {
      // Silently ignore persistence failures to prevent unhandled rejections
      // The cache is cleared in-memory; only durability guarantee is lost
    });
  }

  private async delete(key: string): Promise<void> {
    this.touchedKeys.add(key);
    this.entries.delete(key);
    await this.persistence?.delete(key);
  }

  private async hydrate(): Promise<void> {
    if (!this.persistence) {
      return;
    }

    const persistedEntries = await this.persistence.readAll();

    // If clear() was called while hydration was in flight, the cache must
    // remain empty once ready() resolves. Do not repopulate it.
    if (this.clearedBeforeHydration) {
      return;
    }

    const now = this.now();

    for (const persistedEntry of persistedEntries) {
      if (persistedEntry.expiresAt !== null && persistedEntry.expiresAt <= now) {
        await this.persistence.delete(persistedEntry.key);
        continue;
      }

      // Never let an older persisted entry replace a value that was written
      // (or deleted) after construction but before hydration completed.
      if (this.touchedKeys.has(persistedEntry.key)) {
        continue;
      }

      this.entries.set(persistedEntry.key, {
        key: persistedEntry.key,
        value: deserializeCacheValue(persistedEntry.value),
        expiresAt: persistedEntry.expiresAt,
        willIds: new Set(persistedEntry.willIds),
      });
    }
  }

  private toPersistedEntry(entry: CacheEntry): PersistedCacheEntry {
    return {
      key: entry.key,
      value: serializeCacheValue(entry.value),
      expiresAt: entry.expiresAt,
      willIds: [...entry.willIds],
    };
  }
}

export class MemoryCachePersistenceAdapter implements CachePersistenceAdapter {
  private readonly entries = new Map<string, PersistedCacheEntry>();

  async readAll(): Promise<PersistedCacheEntry[]> {
    return [...this.entries.values()];
  }

  async write(entry: PersistedCacheEntry): Promise<void> {
    this.entries.set(entry.key, entry);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

export class LocalStorageCachePersistenceAdapter implements CachePersistenceAdapter {
  private readonly storage: Storage;
  private readonly storageKey: string;
  private readonly keysIndexKey: string;

  constructor(storage: Storage, options: { key?: string } = {}) {
    if (!storage) {
      throw new Error(
        'LocalStorageCachePersistenceAdapter requires a valid Storage o

/* … truncated 2099 chars — edit only what you need near the top … */

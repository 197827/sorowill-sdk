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

/**
 * Keys that are locale-dependent and must never participate in cache keys.
 *
 * Cache keys are global (shared across locales), so any locale-specific input
 * would fragment the cache and, worse, return stale data formatted for the
 * previous locale after a language switch. Locale-dependent formatting must be
 * applied AFTER cache retrieval, never baked into the key or the cached value.
 */
const LOCALE_DEPENDENT_KEY_PATTERN = /^(locale|language|lang|i18n|i18nLocale|formatLocale|numberLocale|dateLocale)$/i;

function isLocaleDependentKey(key: string): boolean {
  return LOCALE_DEPENDENT_KEY_PATTERN.test(key);
}

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
      const sortedEntries = Object.entries(currentValue as Record<string, unknown>)
        .filter(([key]) => !isLocaleDependentKey(key))
        .sort(([a], [b]) => a.localeCompare(b));
      return Object.fromEntries(sortedEntries);
    }

    return currentValue;
  });
}

/**
 * Builds a locale-agnostic cache key for a read method.
 *
 * Cache key design:
 * - Keys are derived ONLY from the method name and its non-locale arguments.
 * - Locale-dependent inputs (e.g. `locale`, `language`, `i18n`) are stripped
 *   before serialization so the same underlying data maps to a single key
 *   regardless of the active language.
 * - Locale-dependent formatting (currency, number, date formatting) MUST be
 *   applied AFTER retrieving the cached value, never before caching it.
 *
 * This guarantees that switching languages mid-app does not return stale data
 * formatted for the previous locale.
 */
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
      void this.persistence?.delete(key);
      return;
    }

    const entry: CacheEntry = {
      key,
      value,
      expiresAt: this.ttlMs > 0 ? this.now() + this.ttlMs : null,
      willIds: new Set(willIds),
    };

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
    this.entries.clear();
    void this.persistence?.clear().catch(() => {
      // Silently ignore persistence failures to prevent unhandled rejections
      // The cache is cleared in-memory; only durability guarantee is lost
    });
  }

  private async delete(key: string): Promise<void> {
    this.entries.delete(key);
    await this.persistence?.delete(key);
  }

  private async hydrate(): Promise<void> {
    if (!this.persistence) {
      return;
    }

    const persistedEntries = await this.persistence.readAll();
    const now = this.now();

    for (const persistedEntry of persistedEntries) {
      if (persistedEntry.expiresAt !== null && persistedEntry.expiresAt <= now) {
        await this.persistence.delete(persistedEntry.key);
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
        'LocalStorageCachePersistenceAdapter requires a valid Storage object. ' +
        'In server-side rendering (SSR) environments, window.localStorage is unavailable at construction time. ' +
        'Either provide the Storage object conditionally (e.g., only in browsers), ' +
        'or use MemoryCachePersistenceAdapter for SSR environments.',
      );
    }
    this.storage = storage;
    this.storageKey = options.key ?? DEFAULT_CACHE_NAMESPACE;
    this.keysIndexKey = `${this.storageKey}:__keys__`;
  }

  async readAll(): Promise<PersistedCacheEntry[]> {
    const keysJson = this.storage.getItem(this.keysIndexKey);
    if (!keysJson) {
      return [];
    }

    try {
      const keys = JSON.parse(keysJson) as string[];
      const entries: PersistedCacheEntry[] = [];
      for (const key of keys) {
        const entryJson = this.storage.getItem(`${this.storageKey}:${key}`);
        if (entryJson) {
          entries.push(JSON.parse(entryJson) as PersistedCacheEntry);
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  async write(entry: PersistedCacheEntry): Promise<void> {
    this.storage.setItem(`${this.storageKey}:${entry.key}`, JSON.stringify(entry));
    const keysJson = this.storage.getItem(this.keysIndexKey);
    const keys = keysJson ? (JSON.parse(keysJson) as string[]) : [];
    if (!keys.includes(entry.key)) {
      keys.push(entry.key);
      this.storage.setItem(this.keysIndexKey, JSON.stringify(keys));
    }
  }

  async delete(key: string): Promise<void> {
    this.storage.removeItem(`${this.storageKey}:${key}`);
    const keysJson = this.storage.getItem(this.keysIndexKey);
    if (keysJson) {
      const keys = (JSON.parse(keysJson) as string[]).filter((k) => k !== key);
      this.storage.setItem(this.keysIndexKey, JSON.stringify(keys));
    }
  }

  async clear(): Promise<void> {
    const keysJson = this.storage.getItem(this.keysIndexKey);
    if (keysJson) {
      const keys = JSON.parse(keysJson) as string[];
      for (const key of keys) {
        this.storage.removeItem(`${this.storageKey}:${key}`);
      }
    }
    this.storage.removeItem(this.keysIndexKey);
  }
}

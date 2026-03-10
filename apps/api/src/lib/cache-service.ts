export type CacheNamespace = "appointmentQueue" | "patientProfile";
type CacheStatMetric = "hits" | "misses" | "sets" | "invalidations";

export type CacheNamespaceStats = Record<CacheStatMetric, number>;
export type CacheStatsSnapshot = Record<CacheNamespace, CacheNamespaceStats>;

type RedisCacheClient = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
  del: (keys: string | string[]) => Promise<number>;
  hIncrBy: (key: string, field: string, increment: number) => Promise<number>;
  hGetAll: (key: string) => Promise<Record<string, string>>;
};

const CACHE_NAMESPACES: CacheNamespace[] = ["appointmentQueue", "patientProfile"];

const emptyStats = (): CacheStatsSnapshot => ({
  appointmentQueue: { hits: 0, misses: 0, sets: 0, invalidations: 0 },
  patientProfile: { hits: 0, misses: 0, sets: 0, invalidations: 0 }
});

const statKey = (namespace: CacheNamespace): string => `medsys:cache:stats:${namespace}`;
const valueKey = (namespace: CacheNamespace, key: string): string => `medsys:cache:${namespace}:${key}`;

export type CacheService = {
  mode: "memory" | "redis";
  getJson: <T>(namespace: CacheNamespace, key: string) => Promise<T | null>;
  setJson: <T>(namespace: CacheNamespace, key: string, value: T, ttlSeconds: number) => Promise<void>;
  invalidate: (namespace: CacheNamespace, key: string) => Promise<void>;
  getStats: () => Promise<CacheStatsSnapshot>;
};

export const createMemoryCacheService = (): CacheService => {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const stats = emptyStats();

  const increment = (namespace: CacheNamespace, metric: CacheStatMetric) => {
    stats[namespace][metric] += 1;
  };

  return {
    mode: "memory",
    getJson: async <T>(namespace: CacheNamespace, key: string): Promise<T | null> => {
      const entry = store.get(valueKey(namespace, key));
      if (!entry || entry.expiresAt <= Date.now()) {
        store.delete(valueKey(namespace, key));
        increment(namespace, "misses");
        return null;
      }
      increment(namespace, "hits");
      return JSON.parse(entry.value) as T;
    },
    setJson: async <T>(namespace: CacheNamespace, key: string, value: T, ttlSeconds: number): Promise<void> => {
      store.set(valueKey(namespace, key), {
        value: JSON.stringify(value),
        expiresAt: Date.now() + ttlSeconds * 1000
      });
      increment(namespace, "sets");
    },
    invalidate: async (namespace: CacheNamespace, key: string): Promise<void> => {
      store.delete(valueKey(namespace, key));
      increment(namespace, "invalidations");
    },
    getStats: async () => ({
      appointmentQueue: { ...stats.appointmentQueue },
      patientProfile: { ...stats.patientProfile }
    })
  };
};

export const createRedisCacheService = (redisClient: RedisCacheClient): CacheService => ({
  mode: "redis",
  getJson: async <T>(namespace: CacheNamespace, key: string): Promise<T | null> => {
    const raw = await redisClient.get(valueKey(namespace, key));
    if (raw == null) {
      await redisClient.hIncrBy(statKey(namespace), "misses", 1);
      return null;
    }
    await redisClient.hIncrBy(statKey(namespace), "hits", 1);
    return JSON.parse(raw) as T;
  },
  setJson: async <T>(namespace: CacheNamespace, key: string, value: T, ttlSeconds: number): Promise<void> => {
    await redisClient.set(valueKey(namespace, key), JSON.stringify(value), { EX: ttlSeconds });
    await redisClient.hIncrBy(statKey(namespace), "sets", 1);
  },
  invalidate: async (namespace: CacheNamespace, key: string): Promise<void> => {
    await redisClient.del(valueKey(namespace, key));
    await redisClient.hIncrBy(statKey(namespace), "invalidations", 1);
  },
  getStats: async () => {
    const snapshot = emptyStats();

    for (const namespace of CACHE_NAMESPACES) {
      const rawStats = await redisClient.hGetAll(statKey(namespace));
      snapshot[namespace] = {
        hits: Number(rawStats.hits ?? 0),
        misses: Number(rawStats.misses ?? 0),
        sets: Number(rawStats.sets ?? 0),
        invalidations: Number(rawStats.invalidations ?? 0)
      };
    }

    return snapshot;
  }
});

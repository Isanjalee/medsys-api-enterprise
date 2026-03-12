import fp from "fastify-plugin";
import { createClient, type RedisClientType } from "redis";
import { createMemoryCacheService, createRedisCacheService, type CacheService } from "../lib/cache-service.js";

const REDIS_CONNECT_TIMEOUT_MS = 1500;

const cachePlugin = fp(async (app) => {
  if (!app.env.REDIS_URL) {
    app.decorate("cacheService", createMemoryCacheService());
    return;
  }

  const redisClient: RedisClientType = createClient({
    url: app.env.REDIS_URL,
    socket: {
      reconnectStrategy: false,
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS
    }
  });

  redisClient.on("error", (error) => {
    app.log.error({ err: error }, "Cache Redis error");
  });

  try {
    await redisClient.connect();
  } catch (error) {
    app.log.warn({ err: error }, "Cache Redis unavailable at startup, falling back to memory cache");
    app.decorate("cacheService", createMemoryCacheService());
    return;
  }

  const redisCacheService: CacheService = createRedisCacheService(redisClient);
  app.decorate("cacheService", redisCacheService);

  app.addHook("onClose", async () => {
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  });
});

export default cachePlugin;

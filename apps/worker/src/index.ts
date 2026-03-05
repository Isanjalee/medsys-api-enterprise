import { loadEnv } from "@medsys/config";
import { auditLogs, buildDbClient } from "@medsys/db";
import { createClient, type RedisClientType } from "redis";

type AuditQueueEvent = {
  organizationId: string;
  actorUserId?: number | null;
  entityType: string;
  entityId?: number | null;
  action: string;
  requestId?: string | null;
  payload?: unknown;
  createdAt: string;
  ip?: string | null;
  userAgent?: string | null;
};

const run = async () => {
  const env = loadEnv();
  const { db, sql } = buildDbClient(env.DATABASE_URL);
  let redisClient: RedisClientType | null = null;
  let running = true;

  const shouldUseRedis =
    env.AUDIT_TRANSPORT === "redis" || (env.AUDIT_TRANSPORT === "auto" && Boolean(env.REDIS_URL));

  if (!shouldUseRedis) {
    // eslint-disable-next-line no-console
    console.log("worker started in direct-audit mode; queue consumer disabled");
    await sql.end({ timeout: 5 });
    return;
  }

  if (!env.REDIS_URL) {
    throw new Error("AUDIT_TRANSPORT requires REDIS_URL for worker");
  }

  redisClient = createClient({
    url: env.REDIS_URL,
    socket: {
      reconnectStrategy: false
    }
  });
  redisClient.on("error", (error) => {
    // eslint-disable-next-line no-console
    console.error("Redis error", error);
  });
  try {
    await redisClient.connect();
  } catch (error) {
    throw new Error(
      `Audit worker failed to connect Redis at ${env.REDIS_URL}. Start Redis or set AUDIT_TRANSPORT=direct.`
    );
  }

  const processEvent = async (event: AuditQueueEvent): Promise<void> => {
    await db.insert(auditLogs).values({
      organizationId: event.organizationId,
      actorUserId: event.actorUserId ?? null,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      action: event.action,
      ip: event.ip ?? null,
      userAgent: event.userAgent ?? null,
      requestId: event.requestId ?? null,
      payload: event.payload ?? null,
      createdAt: new Date(event.createdAt)
    });
  };

  // eslint-disable-next-line no-console
  console.log("worker started", {
    nodeEnv: env.NODE_ENV,
    auditTransport: env.AUDIT_TRANSPORT,
    queue: env.AUDIT_QUEUE_KEY
  });

  const shutdown = async () => {
    running = false;
    if (redisClient?.isOpen) {
      await redisClient.quit();
    }
    await sql.end({ timeout: 5 });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      const message = await redisClient.brPop(env.AUDIT_QUEUE_KEY, env.AUDIT_WORKER_BLOCK_SECONDS);
      if (!message) {
        continue;
      }
      const event = JSON.parse(message.element) as AuditQueueEvent;
      await processEvent(event);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Audit worker loop error", error);
    }
  }
};

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

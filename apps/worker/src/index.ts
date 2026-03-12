import { loadEnv } from "@medsys/config";
import { auditLogs, buildDbClient } from "@medsys/db";
import { createClient, type RedisClientType } from "redis";
import type { AuditEvent } from "@medsys/types";
import { drainDueRetryMessages, handleAuditQueueMessage, resolveAuditQueueKeys } from "./audit-queue.js";

const REDIS_CONNECT_TIMEOUT_MS = 1500;

const run = async () => {
  const env = loadEnv();
  const { db, sql } = buildDbClient(env.DATABASE_URL);
  let redisClient: RedisClientType | null = null;
  let running = true;
  const queueKeys = resolveAuditQueueKeys(env);

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
      reconnectStrategy: false,
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS
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

  const processEvent = async (event: AuditEvent): Promise<void> => {
    await db.insert(auditLogs).values({
      organizationId: event.organizationId,
      actorUserId: event.actorUserId,
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      ip: event.ip,
      userAgent: event.userAgent,
      requestId: event.requestId,
      payload: event.payload,
      createdAt: new Date(event.createdAt)
    });
  };

  // eslint-disable-next-line no-console
  console.log("worker started", {
    nodeEnv: env.NODE_ENV,
    auditTransport: env.AUDIT_TRANSPORT,
    queue: queueKeys.queueKey,
    retryQueue: queueKeys.retryQueueKey,
    dlq: queueKeys.dlqKey,
    maxRetries: env.AUDIT_MAX_RETRIES
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
      await drainDueRetryMessages(redisClient, queueKeys, Date.now());
      const message = await redisClient.brPop(queueKeys.queueKey, env.AUDIT_WORKER_BLOCK_SECONDS);
      if (!message) {
        continue;
      }
      await handleAuditQueueMessage({
        rawMessage: message.element,
        redisClient,
        queueKeys,
        maxRetries: env.AUDIT_MAX_RETRIES,
        retryBaseDelayMs: env.AUDIT_RETRY_BASE_DELAY_MS,
        processEvent,
        logError: (error, queueMessage) => {
          // eslint-disable-next-line no-console
          console.error("Audit worker processing error", {
            error,
            entityType: queueMessage.event.entityType,
            action: queueMessage.event.action,
            attempt: queueMessage.attempt + 1
          });
        }
      });
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

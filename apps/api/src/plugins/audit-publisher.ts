import fp from "fastify-plugin";
import { createClient, type RedisClientType } from "redis";
import { auditLogs } from "@medsys/db";
import type { AuditEvent } from "@medsys/types";
import type { AuditPublisher } from "../lib/audit-publisher.js";
import { createAuditQueueMessage } from "../lib/audit-publisher.js";

const auditPublisherPlugin = fp(async (app) => {
  const persistDirect = async (event: AuditEvent): Promise<void> => {
    await app.db.insert(auditLogs).values({
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

  const shouldUseRedis =
    app.env.AUDIT_TRANSPORT === "redis" ||
    (app.env.AUDIT_TRANSPORT === "auto" && Boolean(app.env.REDIS_URL));

  if (!shouldUseRedis) {
    const directPublisher: AuditPublisher = {
      mode: "direct",
      publish: persistDirect,
      persistDirect
    };
    app.decorate("auditPublisher", directPublisher);
    return;
  }

  if (!app.env.REDIS_URL) {
    throw new Error("AUDIT_TRANSPORT requires REDIS_URL");
  }

  const redisClient: RedisClientType = createClient({
    url: app.env.REDIS_URL,
    socket: {
      reconnectStrategy: false
    }
  });

  redisClient.on("error", (error) => {
    app.log.error({ err: error }, "Audit queue Redis error");
  });

  try {
    await redisClient.connect();
  } catch (error) {
    app.log.warn({ err: error }, "Audit queue unavailable at startup, falling back to direct mode");
    const directPublisher: AuditPublisher = {
      mode: "direct",
      publish: persistDirect,
      persistDirect
    };
    app.decorate("auditPublisher", directPublisher);
    return;
  }

  const redisPublisher: AuditPublisher = {
    mode: "redis",
    publish: async (event: AuditEvent) => {
      await redisClient.rPush(app.env.AUDIT_QUEUE_KEY, JSON.stringify(createAuditQueueMessage(event)));
    },
    persistDirect
  };

  app.decorate("auditPublisher", redisPublisher);

  app.addHook("onClose", async () => {
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  });
});

export default auditPublisherPlugin;

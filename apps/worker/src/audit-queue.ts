import type { AppEnv } from "@medsys/config";
import type { AuditEvent, AuditQueueMessage } from "@medsys/types";

type RedisQueueClient = {
  rPush: (key: string, value: string) => Promise<unknown>;
  zAdd: (key: string, value: { score: number; value: string }) => Promise<unknown>;
  zRangeByScore: (key: string, min: number | string, max: number | string, options?: { LIMIT?: { offset: number; count: number } }) => Promise<string[]>;
  zRem: (key: string, members: string[]) => Promise<number>;
};

type QueueKeys = {
  queueKey: string;
  retryQueueKey: string;
  dlqKey: string;
};

type HandleMessageInput = {
  rawMessage: string;
  redisClient: RedisQueueClient;
  queueKeys: QueueKeys;
  maxRetries: number;
  retryBaseDelayMs: number;
  processEvent: (event: AuditEvent) => Promise<void>;
  now?: () => number;
  logError?: (error: unknown, message: AuditQueueMessage) => void;
};

export const resolveAuditQueueKeys = (env: AppEnv): QueueKeys => ({
  queueKey: env.AUDIT_QUEUE_KEY,
  retryQueueKey: env.AUDIT_RETRY_QUEUE_KEY ?? `${env.AUDIT_QUEUE_KEY}:retry`,
  dlqKey: env.AUDIT_DLQ_KEY ?? `${env.AUDIT_QUEUE_KEY}:dlq`
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAuditEvent = (value: unknown): value is AuditEvent =>
  isRecord(value) &&
  typeof value.organizationId === "string" &&
  (typeof value.actorUserId === "number" || value.actorUserId === null) &&
  typeof value.entityType === "string" &&
  (typeof value.entityId === "number" || value.entityId === null) &&
  typeof value.action === "string" &&
  (typeof value.ip === "string" || value.ip === null) &&
  (typeof value.userAgent === "string" || value.userAgent === null) &&
  (typeof value.requestId === "string" || value.requestId === null) &&
  "payload" in value &&
  typeof value.createdAt === "string";

const isAuditQueueMessage = (value: unknown): value is AuditQueueMessage =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.attempt === "number" &&
  typeof value.firstQueuedAt === "string" &&
  (typeof value.lastAttemptAt === "string" || value.lastAttemptAt === null) &&
  (typeof value.lastError === "string" || value.lastError === null) &&
  isAuditEvent(value.event);

const createAuditQueueMessage = (event: AuditEvent): AuditQueueMessage => ({
  version: 1,
  event,
  attempt: 0,
  firstQueuedAt: event.createdAt,
  lastAttemptAt: null,
  lastError: null
});

const parseAuditQueueMessage = (raw: string): AuditQueueMessage => {
  const parsed = JSON.parse(raw) as unknown;

  if (isAuditQueueMessage(parsed)) {
    return parsed;
  }

  if (isAuditEvent(parsed)) {
    return createAuditQueueMessage(parsed);
  }

  throw new Error("Invalid audit queue message");
};

export const getRetryDelayMs = (attempt: number, baseDelayMs: number): number =>
  baseDelayMs * 2 ** Math.max(attempt - 1, 0);

export const createRetryMessage = (
  message: AuditQueueMessage,
  error: unknown,
  nowMs: number
): AuditQueueMessage => ({
  ...message,
  attempt: message.attempt + 1,
  lastAttemptAt: new Date(nowMs).toISOString(),
  lastError: error instanceof Error ? error.message : String(error)
});

export const drainDueRetryMessages = async (
  redisClient: RedisQueueClient,
  queueKeys: QueueKeys,
  nowMs: number,
  batchSize = 100
): Promise<number> => {
  const dueMessages = await redisClient.zRangeByScore(queueKeys.retryQueueKey, 0, nowMs, {
    LIMIT: { offset: 0, count: batchSize }
  });

  if (dueMessages.length === 0) {
    return 0;
  }

  await redisClient.zRem(queueKeys.retryQueueKey, dueMessages);
  for (const message of dueMessages) {
    await redisClient.rPush(queueKeys.queueKey, message);
  }

  return dueMessages.length;
};

export const handleAuditQueueMessage = async ({
  rawMessage,
  redisClient,
  queueKeys,
  maxRetries,
  retryBaseDelayMs,
  processEvent,
  now = () => Date.now(),
  logError
}: HandleMessageInput): Promise<"processed" | "retried" | "dead-lettered"> => {
  const message = parseAuditQueueMessage(rawMessage);

  try {
    await processEvent(message.event);
    return "processed";
  } catch (error) {
    logError?.(error, message);
    const retryMessage = createRetryMessage(message, error, now());

    if (retryMessage.attempt >= maxRetries) {
      await redisClient.rPush(queueKeys.dlqKey, JSON.stringify(retryMessage));
      return "dead-lettered";
    }

    const retryAt = now() + getRetryDelayMs(retryMessage.attempt, retryBaseDelayMs);
    await redisClient.zAdd(queueKeys.retryQueueKey, {
      score: retryAt,
      value: JSON.stringify(retryMessage)
    });
    return "retried";
  }
};

export const normalizeAuditQueueMessage = (event: AuditEvent | AuditQueueMessage): AuditQueueMessage =>
  "version" in event ? event : createAuditQueueMessage(event);

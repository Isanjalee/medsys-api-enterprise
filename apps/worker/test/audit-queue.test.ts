import test from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent } from "@medsys/types";
import {
  createRetryMessage,
  drainDueRetryMessages,
  getRetryDelayMs,
  handleAuditQueueMessage,
  normalizeAuditQueueMessage
} from "../src/audit-queue.js";

const baseEvent: AuditEvent = {
  organizationId: "11111111-1111-1111-1111-111111111111",
  actorUserId: 1,
  entityType: "patient",
  entityId: 10,
  action: "create",
  ip: "127.0.0.1",
  userAgent: "test",
  requestId: "123e4567-e89b-12d3-a456-426614174000",
  payload: { ok: true },
  createdAt: "2026-03-10T10:00:00.000Z"
};

const createRedisStub = () => {
  const lists = new Map<string, string[]>();
  const zsets = new Map<string, Array<{ score: number; value: string }>>();

  return {
    lists,
    zsets,
    async rPush(key: string, value: string) {
      const current = lists.get(key) ?? [];
      current.push(value);
      lists.set(key, current);
      return current.length;
    },
    async zAdd(key: string, entry: { score: number; value: string }) {
      const current = zsets.get(key) ?? [];
      current.push(entry);
      current.sort((left, right) => left.score - right.score);
      zsets.set(key, current);
      return 1;
    },
    async zRangeByScore(
      key: string,
      min: number | string,
      max: number | string,
      options?: { LIMIT?: { offset: number; count: number } }
    ) {
      const lower = Number(min);
      const upper = Number(max);
      const current = (zsets.get(key) ?? [])
        .filter((entry) => entry.score >= lower && entry.score <= upper)
        .map((entry) => entry.value);
      const offset = options?.LIMIT?.offset ?? 0;
      const count = options?.LIMIT?.count ?? current.length;
      return current.slice(offset, offset + count);
    },
    async zRem(key: string, members: string[]) {
      const current = zsets.get(key) ?? [];
      const next = current.filter((entry) => !members.includes(entry.value));
      zsets.set(key, next);
      return current.length - next.length;
    }
  };
};

test("getRetryDelayMs backs off exponentially", () => {
  assert.equal(getRetryDelayMs(1, 250), 250);
  assert.equal(getRetryDelayMs(2, 250), 500);
  assert.equal(getRetryDelayMs(3, 250), 1000);
});

test("createRetryMessage increments attempts and records error metadata", () => {
  const message = normalizeAuditQueueMessage(baseEvent);
  const retried = createRetryMessage(message, new Error("boom"), Date.parse("2026-03-10T10:05:00.000Z"));

  assert.equal(retried.attempt, 1);
  assert.equal(retried.lastError, "boom");
  assert.equal(retried.lastAttemptAt, "2026-03-10T10:05:00.000Z");
});

test("handleAuditQueueMessage schedules a retry before max retries", async () => {
  const redis = createRedisStub();
  const queueKeys = {
    queueKey: "audit:events",
    retryQueueKey: "audit:events:retry",
    dlqKey: "audit:events:dlq"
  };

  const outcome = await handleAuditQueueMessage({
    rawMessage: JSON.stringify(normalizeAuditQueueMessage(baseEvent)),
    redisClient: redis,
    queueKeys,
    maxRetries: 3,
    retryBaseDelayMs: 250,
    processEvent: async () => {
      throw new Error("temporary failure");
    },
    now: () => 1000
  });

  assert.equal(outcome, "retried");
  const retryEntries = redis.zsets.get(queueKeys.retryQueueKey) ?? [];
  assert.equal(retryEntries.length, 1);
  assert.equal(retryEntries[0].score, 1250);
  assert.deepEqual(redis.lists.get(queueKeys.dlqKey) ?? [], []);
});

test("handleAuditQueueMessage moves exhausted messages to the DLQ", async () => {
  const redis = createRedisStub();
  const queueKeys = {
    queueKey: "audit:events",
    retryQueueKey: "audit:events:retry",
    dlqKey: "audit:events:dlq"
  };
  const exhaustedMessage = {
    ...normalizeAuditQueueMessage(baseEvent),
    attempt: 2,
    lastError: "still failing"
  };

  const outcome = await handleAuditQueueMessage({
    rawMessage: JSON.stringify(exhaustedMessage),
    redisClient: redis,
    queueKeys,
    maxRetries: 3,
    retryBaseDelayMs: 250,
    processEvent: async () => {
      throw new Error("permanent failure");
    },
    now: () => 1000
  });

  assert.equal(outcome, "dead-lettered");
  const dlqEntries = redis.lists.get(queueKeys.dlqKey) ?? [];
  assert.equal(dlqEntries.length, 1);
  assert.deepEqual(redis.zsets.get(queueKeys.retryQueueKey) ?? [], []);
});

test("drainDueRetryMessages pushes due retry entries back to the main queue", async () => {
  const redis = createRedisStub();
  const queueKeys = {
    queueKey: "audit:events",
    retryQueueKey: "audit:events:retry",
    dlqKey: "audit:events:dlq"
  };
  const normalizedMessage = JSON.stringify(normalizeAuditQueueMessage(baseEvent));
  await redis.zAdd(queueKeys.retryQueueKey, { score: 1000, value: normalizedMessage });
  await redis.zAdd(queueKeys.retryQueueKey, { score: 3000, value: "later" });

  const moved = await drainDueRetryMessages(redis, queueKeys, 1500);

  assert.equal(moved, 1);
  assert.deepEqual(redis.lists.get(queueKeys.queueKey), [normalizedMessage]);
  assert.deepEqual(
    redis.zsets.get(queueKeys.retryQueueKey)?.map((entry) => entry.value),
    ["later"]
  );
});

test("legacy raw audit events are still accepted by the worker", async () => {
  const redis = createRedisStub();
  const queueKeys = {
    queueKey: "audit:events",
    retryQueueKey: "audit:events:retry",
    dlqKey: "audit:events:dlq"
  };
  let processed = 0;

  const outcome = await handleAuditQueueMessage({
    rawMessage: JSON.stringify(baseEvent),
    redisClient: redis,
    queueKeys,
    maxRetries: 3,
    retryBaseDelayMs: 250,
    processEvent: async () => {
      processed += 1;
    }
  });

  assert.equal(outcome, "processed");
  assert.equal(processed, 1);
});

import type { AuditEvent, AuditQueueMessage } from "@medsys/types";

export const createAuditQueueMessage = (event: AuditEvent): AuditQueueMessage => ({
  version: 1,
  event,
  attempt: 0,
  firstQueuedAt: event.createdAt,
  lastAttemptAt: null,
  lastError: null
});

export type AuditPublisher = {
  mode: "direct" | "redis";
  publish: (event: AuditEvent) => Promise<void>;
  persistDirect: (event: AuditEvent) => Promise<void>;
};

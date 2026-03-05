export type AuditEvent = {
  organizationId: string;
  actorUserId: number | null;
  entityType: string;
  entityId: number | null;
  action: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  payload: unknown;
  createdAt: string;
};

export type AuditPublisher = {
  mode: "direct" | "redis";
  publish: (event: AuditEvent) => Promise<void>;
  persistDirect: (event: AuditEvent) => Promise<void>;
};

import type { FastifyRequest } from "fastify";
import type { AuditEvent } from "./audit-publisher.js";

type AuditInput = {
  entityType: string;
  action: string;
  entityId?: number | null;
  payload?: unknown;
};

export const writeAuditLog = async (request: FastifyRequest, input: AuditInput): Promise<void> => {
  const actor = request.actor;
  const organizationId = actor?.organizationId ?? request.server.env.ORGANIZATION_ID;
  const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    request.id
  )
    ? request.id
    : null;
  const event: AuditEvent = {
    organizationId,
    actorUserId: actor?.userId ?? null,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    action: input.action,
    ip: request.ip ?? null,
    userAgent: request.headers["user-agent"] ?? null,
    requestId,
    payload: input.payload ?? null,
    createdAt: new Date().toISOString()
  };

  try {
    await request.server.auditPublisher.publish(event);
  } catch (error) {
    request.log.error({ err: error }, "Audit publish failed, writing directly");
    await request.server.auditPublisher.persistDirect(event);
  }
};

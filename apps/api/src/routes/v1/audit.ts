import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { auditLogs } from "@medsys/db";
import { listAuditLogsQuerySchema } from "@medsys/validation";
import { parseOrThrowValidation } from "../../lib/http-error.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const auditRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Audit", "AuditController", {
    "GET /logs": {
      operationId: "AuditController_findLogs",
      summary: "List audit log entries"
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get("/logs", { preHandler: app.authorizePermissions(["audit.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(listAuditLogsQuerySchema, request.query ?? {});

    const conditions = [eq(auditLogs.organizationId, actor.organizationId)];
    if (query.entityType) conditions.push(eq(auditLogs.entityType, query.entityType));
    if (query.action) conditions.push(eq(auditLogs.action, query.action));
    if (query.from) conditions.push(gte(auditLogs.createdAt, new Date(query.from)));
    if (query.to) conditions.push(lte(auditLogs.createdAt, new Date(query.to)));

    const whereClause = and(...conditions);
    const limit = Math.min(query.limit ?? 100, 1000);
    const offset = query.offset ?? 0;

    const [items, totalRows] = await Promise.all([
      app.readDb
        .select()
        .from(auditLogs)
        .where(whereClause)
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset),
      app.readDb.select({ count: sql<number>`count(*)` }).from(auditLogs).where(whereClause)
    ]);

    return {
      items,
      limit,
      offset,
      total: Number(totalRows[0]?.count ?? 0)
    };
  });
};

export default auditRoutes;

import type { FastifyPluginAsync } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { appointments, inventoryItems, patients, prescriptions } from "@medsys/db";
import { applyRouteDocs } from "../../lib/route-docs.js";
import { resolveActiveWorkflowProfile } from "../../lib/user-permissions.js";

const analyticsRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Analytics", "AnalyticsController", {
    "GET /overview": {
      operationId: "AnalyticsController_overview",
      summary: "Get analytics overview counters"
    },
    "GET /cache": {
      operationId: "AnalyticsController_cacheStats",
      summary: "Get cache hit-rate counters"
    },
    "GET /observability": {
      operationId: "AnalyticsController_observability",
      summary: "Get request tracing, metrics, and security telemetry"
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get("/overview", { preHandler: app.authorizePermissions(["analytics.read"]) }, async (request) => {
    const actor = request.actor!;
    const [patientCount, waitingCount, prescriptionCount, lowStockCount] = await Promise.all([
      app.analyticsDb
        .select({ count: sql<number>`count(*)` })
        .from(patients)
        .where(eq(patients.organizationId, actor.organizationId)),
      app.analyticsDb
        .select({ count: sql<number>`count(*)` })
        .from(appointments)
        .where(and(eq(appointments.organizationId, actor.organizationId), eq(appointments.status, "waiting"))),
      app.analyticsDb
        .select({ count: sql<number>`count(*)` })
        .from(prescriptions)
        .where(eq(prescriptions.organizationId, actor.organizationId)),
      app.analyticsDb
        .select({ count: sql<number>`count(*)` })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.organizationId, actor.organizationId), sql`${inventoryItems.stock} <= ${inventoryItems.reorderLevel}`))
    ]);

    return {
      patients: Number(patientCount[0]?.count ?? 0),
      waitingAppointments: Number(waitingCount[0]?.count ?? 0),
      prescriptions: Number(prescriptionCount[0]?.count ?? 0),
      lowStockItems: Number(lowStockCount[0]?.count ?? 0),
      role_context: {
        role: actor.role,
        active_role: actor.activeRole,
        roles: actor.roles,
        workflow_profile: resolveActiveWorkflowProfile(
          actor.roles,
          actor.activeRole,
          actor.workflowProfiles.doctor?.mode ?? null
        )
      }
    };
  });

  app.get("/cache", { preHandler: app.authorizePermissions(["analytics.read"]) }, async () => {
    return app.cacheService.getStats();
  });

  app.get("/observability", { preHandler: app.authorizePermissions(["analytics.read"]) }, async () => {
    return {
      metrics: app.observability.getMetrics(),
      security: app.securityService.getStats()
    };
  });
};

export default analyticsRoutes;

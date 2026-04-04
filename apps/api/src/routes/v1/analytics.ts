import type { FastifyPluginAsync } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { appointments, inventoryItems, patients, prescriptions } from "@medsys/db";
import { analyticsDashboardQuerySchema } from "@medsys/validation";
import { buildAnalyticsDashboard } from "../../lib/analytics-dashboard.js";
import { parseOrThrowValidation, validationError } from "../../lib/http-error.js";
import { applyRouteDocs } from "../../lib/route-docs.js";
import { resolveActiveWorkflowProfile } from "../../lib/user-permissions.js";

const analyticsRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Analytics", "AnalyticsController", {
    "GET /overview": {
      operationId: "AnalyticsController_overview",
      summary: "Get analytics overview counters"
    },
    "GET /dashboard": {
      operationId: "AnalyticsController_dashboard",
      summary: "Get role-aware analytics dashboard blocks"
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

  app.get("/dashboard", { preHandler: app.authorizePermissions(["analytics.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(analyticsDashboardQuerySchema, request.query ?? {});
    const requestedRole = query.role ?? actor.role;
    const rangePreset = query.range ?? "7d";

    if (actor.role !== "owner" && requestedRole !== actor.role) {
      throw validationError([
        {
          field: "role",
          message: "Only owner users can request another role dashboard."
        }
      ]);
    }

    const resolvedDoctorId =
      requestedRole === "doctor" ? (query.doctorId ?? (actor.role === "doctor" ? actor.userId : null)) : null;
    const resolvedAssistantId =
      requestedRole === "assistant"
        ? (query.assistantId ?? (actor.role === "assistant" ? actor.userId : null))
        : null;

    if (requestedRole === "doctor" && resolvedDoctorId === null) {
      throw validationError([
        {
          field: "doctorId",
          message: "doctorId is required when requesting a doctor dashboard outside a doctor session."
        }
      ]);
    }

    if (requestedRole === "assistant" && resolvedAssistantId === null) {
      throw validationError([
        {
          field: "assistantId",
          message: "assistantId is required when requesting an assistant dashboard outside an assistant session."
        }
      ]);
    }

    const now = new Date();
    const start =
      rangePreset === "custom"
        ? new Date(`${query.dateFrom!}T00:00:00.000Z`)
        : rangePreset === "1d"
          ? new Date(now.getTime() - 24 * 60 * 60 * 1000)
          : rangePreset === "30d"
            ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
            : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const end = rangePreset === "custom" ? new Date(`${query.dateTo!}T23:59:59.999Z`) : now;

    return buildAnalyticsDashboard({
      db: app.analyticsDb,
      organizationId: actor.organizationId,
      actor: {
        role: actor.role as "owner" | "doctor" | "assistant",
        activeRole: (actor.activeRole ?? null) as "owner" | "doctor" | "assistant" | null,
        roles: actor.roles as Array<"owner" | "doctor" | "assistant">,
        userId: actor.userId
      },
      scope: {
        role: requestedRole,
        doctorId: resolvedDoctorId,
        assistantId: resolvedAssistantId
      },
      range: {
        preset: rangePreset,
        start,
        end
      },
      generatedAt: now,
      workflowProfile:
        resolveActiveWorkflowProfile(actor.roles, actor.activeRole, actor.workflowProfiles.doctor?.mode ?? null) ??
        ({ mode: "standard" } as const)
    });
  });

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

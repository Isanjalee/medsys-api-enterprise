import type { FastifyPluginAsync } from "fastify";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { appointments, dispenseRecords, encounters, inventoryItems, patients, prescriptions } from "@medsys/db";
import { analyticsDashboardQuerySchema } from "@medsys/validation";
import { buildAnalyticsDashboard } from "../../lib/analytics-dashboard.js";
import { parseOrThrowValidation, validationError } from "../../lib/http-error.js";
import { applyRouteDocs } from "../../lib/route-docs.js";
import { resolveActiveWorkflowProfile } from "../../lib/user-permissions.js";

const ANALYTICS_DASHBOARD_CACHE_TTL_SECONDS = 20;

const dashboardCacheKey = (input: {
  organizationId: string;
  userId: number;
  role: "owner" | "doctor" | "assistant";
  activeRole: "owner" | "doctor" | "assistant";
  roles: Array<"owner" | "doctor" | "assistant">;
  query: {
    range: "1d" | "7d" | "30d" | "custom";
    operationMode: "walk_in" | "appointment" | "hybrid";
    role: "owner" | "doctor" | "assistant";
    doctorId: number | null;
    assistantId: number | null;
    dateFrom: string | null;
    dateTo: string | null;
  };
}): string =>
  JSON.stringify({
    route: "analytics.dashboard",
    organizationId: input.organizationId,
    userId: input.userId,
    role: input.role,
    activeRole: input.activeRole,
    roles: [...input.roles].sort(),
    query: input.query
  });

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
          message: "Only owner users can request another role dashboard.",
          code: "ROLE_SCOPE_NOT_ALLOWED"
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
          message: "doctorId is required when requesting a doctor dashboard outside a doctor session.",
          code: "DOCTOR_ID_REQUIRED_FOR_ROLE_SCOPE"
        }
      ]);
    }

    if (requestedRole === "assistant" && resolvedAssistantId === null) {
      throw validationError([
        {
          field: "assistantId",
          message: "assistantId is required when requesting an assistant dashboard outside an assistant session.",
          code: "ASSISTANT_ID_REQUIRED_FOR_ROLE_SCOPE"
        }
      ]);
    }

    const cacheKey = dashboardCacheKey({
      organizationId: actor.organizationId,
      userId: actor.userId,
      role: actor.role,
      activeRole: actor.activeRole,
      roles: actor.roles,
      query: {
        range: rangePreset,
        operationMode: query.operationMode ?? "hybrid",
        role: requestedRole,
        doctorId: resolvedDoctorId,
        assistantId: resolvedAssistantId,
        dateFrom: query.dateFrom ?? null,
        dateTo: query.dateTo ?? null
      }
    });
    const cached = await app.cacheService.getJson<Record<string, unknown>>("readResponse", cacheKey);
    if (cached !== null) {
      return cached;
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

    const payload = await buildAnalyticsDashboard({
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
      operationMode: query.operationMode ?? "hybrid",
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
    await app.cacheService.setJson("readResponse", cacheKey, payload, ANALYTICS_DASHBOARD_CACHE_TTL_SECONDS);
    return payload;
  });

  app.get("/earnings", { preHandler: app.authorizePermissions(["analytics.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(analyticsDashboardQuerySchema, request.query ?? {});
    const rangePreset = query.range ?? "7d";
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

    const rows = await app.analyticsDb
      .select({
        total: sql<string>`COALESCE(SUM(${encounters.priceLkr}), 0)`,
        dispenseCount: sql<string>`COUNT(${encounters.priceLkr})`
      })
      .from(encounters)
      .where(
        and(
          eq(encounters.organizationId, actor.organizationId),
          gte(encounters.checkedAt, start),
          lte(encounters.checkedAt, end)
        )
      );

    return {
      currency: "LKR",
      totalEarnings: Number(rows[0]?.total ?? 0),
      dispenseCount: Number(rows[0]?.dispenseCount ?? 0),
      range: rangePreset,
      generatedAt: now.toISOString()
    };
  });

  app.get("/overview", { preHandler: app.authorizePermissions(["analytics.read"]) }, async (request) => {
    const actor = request.actor!;
    const [patientCount, waitingCount, prescriptionCount, lowStockCount, genderRows, encounterCount, statusRows] =
      await Promise.all([
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
          .where(and(eq(inventoryItems.organizationId, actor.organizationId), sql`${inventoryItems.stock} <= ${inventoryItems.reorderLevel}`)),
        // gender breakdown, encounter total, and appointment status distribution are
        // aggregated server-side so the dashboard never needs to pull raw rows.
        app.analyticsDb
          .select({ gender: patients.gender, count: sql<number>`count(*)` })
          .from(patients)
          .where(eq(patients.organizationId, actor.organizationId))
          .groupBy(patients.gender),
        app.analyticsDb
          .select({ count: sql<number>`count(*)` })
          .from(encounters)
          .where(eq(encounters.organizationId, actor.organizationId)),
        app.analyticsDb
          .select({ status: appointments.status, count: sql<number>`count(*)` })
          .from(appointments)
          .where(eq(appointments.organizationId, actor.organizationId))
          .groupBy(appointments.status)
      ]);

    const genderOf = (g: string) => Number(genderRows.find((row) => row.gender === g)?.count ?? 0);
    const appointmentStatusCounts = {
      waiting: 0,
      in_consultation: 0,
      completed: 0,
      cancelled: 0
    };
    for (const row of statusRows) {
      if (row.status in appointmentStatusCounts) {
        appointmentStatusCounts[row.status as keyof typeof appointmentStatusCounts] = Number(row.count ?? 0);
      }
    }
    const totalAppointments = Object.values(appointmentStatusCounts).reduce((sum, n) => sum + n, 0);
    const totalPatients = Number(patientCount[0]?.count ?? 0);

    return {
      patients: totalPatients,
      waitingAppointments: Number(waitingCount[0]?.count ?? 0),
      prescriptions: Number(prescriptionCount[0]?.count ?? 0),
      lowStockItems: Number(lowStockCount[0]?.count ?? 0),
      totalPatients,
      totalMale: genderOf("male"),
      totalFemale: genderOf("female"),
      totalEncounters: Number(encounterCount[0]?.count ?? 0),
      totalAppointments,
      appointmentStatusCounts,
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

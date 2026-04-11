import type { FastifyPluginAsync } from "fastify";
import { parseOrThrowValidation, validationError } from "../../lib/http-error.js";
import { applyRouteDocs } from "../../lib/route-docs.js";
import { dailySummaryHistoryQuerySchema, dailySummaryQuerySchema, reportsQuerySchema } from "@medsys/validation";
import {
  buildAssistantPerformanceReport,
  buildClinicOverviewReport,
  buildDoctorPerformanceReport,
  buildInventoryUsageReport,
  buildPatientFollowupReport
} from "../../lib/reports/report-service.js";
import { buildDailySummary, listDailySummaryHistory, storeDailySummarySnapshot } from "../../lib/reports/daily-summary-service.js";

type AuthenticatedActor = {
  userId: number;
  role: "owner" | "doctor" | "assistant";
  roles: Array<"owner" | "doctor" | "assistant">;
  activeRole: "owner" | "doctor" | "assistant";
  organizationId: string;
  permissions: string[];
  workflowProfiles: unknown;
  extraPermissions: string[];
};

const reportsRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Reports", "ReportsController", {
    "GET /clinic-overview": {
      operationId: "ReportsController_clinicOverview",
      summary: "Get clinic overview report blocks"
    },
    "GET /doctor-performance": {
      operationId: "ReportsController_doctorPerformance",
      summary: "Get doctor performance report blocks"
    },
    "GET /assistant-performance": {
      operationId: "ReportsController_assistantPerformance",
      summary: "Get assistant performance report blocks"
    },
    "GET /inventory-usage": {
      operationId: "ReportsController_inventoryUsage",
      summary: "Get inventory usage report blocks"
    },
    "GET /patient-followup": {
      operationId: "ReportsController_patientFollowup",
      summary: "Get patient follow-up report blocks"
    },
    "GET /daily-summary": {
      operationId: "ReportsController_dailySummary",
      summary: "Get and persist a role-aware daily summary snapshot"
    },
    "GET /daily-summary/history": {
      operationId: "ReportsController_dailySummaryHistory",
      summary: "Get stored daily summary snapshots"
    }
  });

  const parseRange = (query: {
    range?: "7d" | "30d" | "custom";
    dateFrom?: string | null;
    dateTo?: string | null;
  }) => {
    const now = new Date();
    const start =
      query.range === "custom"
        ? new Date(`${query.dateFrom!}T00:00:00.000Z`)
        : query.range === "30d"
          ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
          : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const end = query.range === "custom" ? new Date(`${query.dateTo!}T23:59:59.999Z`) : now;
    return { preset: query.range ?? "7d", start, end } as const;
  };

  const validateScopedFilters = (
    actor: AuthenticatedActor,
    query: { doctorId?: number | null; assistantId?: number | null }
  ) => {
    if (actor.role === "owner") {
      return;
    }

    if (query.doctorId && (actor.role !== "doctor" || query.doctorId !== actor.userId)) {
      throw validationError([
        {
          field: "doctorId",
          message: "Only owner users can request another user's scoped report."
        }
      ]);
    }

    if (query.assistantId && (actor.role !== "assistant" || query.assistantId !== actor.userId)) {
      throw validationError([
        {
          field: "assistantId",
          message: "Only owner users can request another user's scoped report."
        }
      ]);
    }
  };

  const resolveDailySummaryScope = (
    actor: AuthenticatedActor,
    query: {
      role?: "doctor" | "assistant" | "owner";
      doctorId?: number | null;
      assistantId?: number | null;
      visitMode?: "appointment" | "walk_in";
      doctorWorkflowMode?: "self_service" | "clinic_supported" | null;
    }
  ) => {
    const requestedRole = query.role ?? actor.role;

    if (actor.role !== "owner" && requestedRole !== actor.role) {
      throw validationError([
        {
          field: "role",
          message: "Only owner users can request another role summary."
        }
      ]);
    }

    const resolvedDoctorId =
      requestedRole === "doctor" ? (actor.role === "doctor" ? actor.userId : (query.doctorId ?? null)) : null;
    const resolvedAssistantId =
      requestedRole === "assistant" ? (actor.role === "assistant" ? actor.userId : (query.assistantId ?? null)) : null;

    if (requestedRole === "doctor" && resolvedDoctorId === null) {
      throw validationError([
        {
          field: "doctorId",
          message: "doctorId is required when requesting a doctor daily summary outside a doctor session."
        }
      ]);
    }

    if (requestedRole === "assistant" && resolvedAssistantId === null) {
      throw validationError([
        {
          field: "assistantId",
          message: "assistantId is required when requesting an assistant daily summary outside an assistant session."
        }
      ]);
    }

    return {
      role: requestedRole,
      doctorId: resolvedDoctorId,
      assistantId: resolvedAssistantId,
      actorUserId: requestedRole === "owner" ? null : requestedRole === "doctor" ? resolvedDoctorId : resolvedAssistantId,
      visitMode: query.visitMode ?? null,
      doctorWorkflowMode: query.doctorWorkflowMode ?? null
    } as const;
  };

  app.addHook("preHandler", app.authenticate);

  app.get("/daily-summary", { preHandler: app.authorizePermissions(["analytics.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(dailySummaryQuerySchema, request.query ?? {});
    validateScopedFilters(actor, query);
    const generatedAt = new Date();
    const summaryDate = query.date ?? generatedAt.toISOString().slice(0, 10);
    const scope = resolveDailySummaryScope(actor, query);
    const payload = await buildDailySummary({
      db: app.analyticsDb,
      organizationId: actor.organizationId,
      scope,
      summaryDate,
      generatedAt
    });

    const snapshot = await storeDailySummarySnapshot({
      db: app.db,
      organizationId: actor.organizationId,
      scope,
      summaryDate,
      payload
    });

    return {
      snapshotId: snapshot?.id ?? null,
      ...payload
    };
  });

  app.get("/daily-summary/history", { preHandler: app.authorizePermissions(["analytics.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(dailySummaryHistoryQuerySchema, request.query ?? {});
    validateScopedFilters(actor, query);
    const scope = resolveDailySummaryScope(actor, query);
    const items = await listDailySummaryHistory({
      db: app.analyticsDb,
      organizationId: actor.organizationId,
      scope,
      summaryDate: query.date ?? null,
      limit: query.limit ?? 10
    });

    return {
      roleContext: scope.role,
      items
    };
  });

  app.get("/clinic-overview", { preHandler: app.authorizePermissions(["analytics.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(reportsQuerySchema, request.query ?? {});
    validateScopedFilters(actor, query);
    const now = new Date();
    return buildClinicOverviewReport({
      db: app.analyticsDb,
      organizationId: actor.organizationId,
      range: parseRange(query),
      filters: query,
      generatedAt: now
    });
  });

  app.get("/doctor-performance", { preHandler: app.authorizePermissions(["analytics.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(reportsQuerySchema, request.query ?? {});
    validateScopedFilters(actor, query);
    const now = new Date();
    return buildDoctorPerformanceReport({
      db: app.analyticsDb,
      organizationId: actor.organizationId,
      range: parseRange(query),
      filters: {
        doctorId: actor.role === "doctor" ? actor.userId : (query.doctorId ?? null),
        assistantId: null,
        visitMode: query.visitMode,
        doctorWorkflowMode: query.doctorWorkflowMode ?? null
      },
      generatedAt: now
    });
  });

  app.get("/assistant-performance", { preHandler: app.authorizePermissions(["analytics.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(reportsQuerySchema, request.query ?? {});
    validateScopedFilters(actor, query);
    const now = new Date();
    return buildAssistantPerformanceReport({
      db: app.analyticsDb,
      organizationId: actor.organizationId,
      range: parseRange(query),
      filters: {
        doctorId: null,
        assistantId: actor.role === "assistant" ? actor.userId : (query.assistantId ?? null),
        visitMode: query.visitMode,
        doctorWorkflowMode: query.doctorWorkflowMode ?? null
      },
      generatedAt: now
    });
  });

  app.get("/inventory-usage", { preHandler: app.authorizePermissions(["analytics.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(reportsQuerySchema, request.query ?? {});
    validateScopedFilters(actor, query);
    const now = new Date();
    return buildInventoryUsageReport({
      db: app.analyticsDb,
      organizationId: actor.organizationId,
      range: parseRange(query),
      filters: query,
      generatedAt: now
    });
  });

  app.get("/patient-followup", { preHandler: app.authorizePermissions(["analytics.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(reportsQuerySchema, request.query ?? {});
    validateScopedFilters(actor, query);
    const now = new Date();
    return buildPatientFollowupReport({
      db: app.analyticsDb,
      organizationId: actor.organizationId,
      range: parseRange(query),
      filters: {
        doctorId: actor.role === "doctor" ? actor.userId : (query.doctorId ?? null),
        assistantId: null,
        visitMode: query.visitMode,
        doctorWorkflowMode: query.doctorWorkflowMode ?? null
      },
      generatedAt: now
    });
  });
};

export default reportsRoutes;

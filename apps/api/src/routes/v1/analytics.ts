import type { FastifyPluginAsync } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { appointments, inventoryItems, patients, prescriptions } from "@medsys/db";
import { applyRouteDocs } from "../../lib/route-docs.js";

const analyticsRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Analytics", "AnalyticsController", {
    "GET /overview": {
      operationId: "AnalyticsController_overview",
      summary: "Get analytics overview counters"
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get("/overview", { preHandler: app.authorize(["owner", "doctor", "assistant"]) }, async (request) => {
    const actor = request.actor!;
    const [patientCount, waitingCount, prescriptionCount, lowStockCount] = await Promise.all([
      app.readDb
        .select({ count: sql<number>`count(*)` })
        .from(patients)
        .where(eq(patients.organizationId, actor.organizationId)),
      app.readDb
        .select({ count: sql<number>`count(*)` })
        .from(appointments)
        .where(and(eq(appointments.organizationId, actor.organizationId), eq(appointments.status, "waiting"))),
      app.readDb
        .select({ count: sql<number>`count(*)` })
        .from(prescriptions)
        .where(eq(prescriptions.organizationId, actor.organizationId)),
      app.readDb
        .select({ count: sql<number>`count(*)` })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.organizationId, actor.organizationId), sql`${inventoryItems.stock} <= ${inventoryItems.reorderLevel}`))
    ]);

    return {
      patients: Number(patientCount[0]?.count ?? 0),
      waitingAppointments: Number(waitingCount[0]?.count ?? 0),
      prescriptions: Number(prescriptionCount[0]?.count ?? 0),
      lowStockItems: Number(lowStockCount[0]?.count ?? 0)
    };
  });
};

export default analyticsRoutes;

import type { FastifyPluginAsync } from "fastify";
import authRoutes from "./v1/auth.js";
import patientRoutes from "./v1/patients.js";
import familyRoutes from "./v1/families.js";
import appointmentRoutes from "./v1/appointments.js";
import encounterRoutes from "./v1/encounters.js";
import prescriptionRoutes from "./v1/prescriptions.js";
import inventoryRoutes from "./v1/inventory.js";
import analyticsRoutes from "./v1/analytics.js";
import auditRoutes from "./v1/audit.js";

const routesPlugin: FastifyPluginAsync = async (app) => {
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(patientRoutes, { prefix: "/patients" });
  await app.register(familyRoutes, { prefix: "/families" });
  await app.register(appointmentRoutes, { prefix: "/appointments" });
  await app.register(encounterRoutes, { prefix: "/encounters" });
  await app.register(prescriptionRoutes, { prefix: "/prescriptions" });
  await app.register(inventoryRoutes, { prefix: "/inventory" });
  await app.register(analyticsRoutes, { prefix: "/analytics" });
  await app.register(auditRoutes, { prefix: "/audit" });
};

export default routesPlugin;

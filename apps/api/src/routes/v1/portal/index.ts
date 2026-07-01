import type { FastifyPluginAsync } from "fastify";
import portalAuthRoutes from "./auth.js";
import portalClinicalRoutes from "./clinical.js";
import portalDoctorsRoutes from "./doctors.js";
import portalDocumentsRoutes from "./documents.js";
import portalProfileRoutes from "./profile.js";

const portalRoutes: FastifyPluginAsync = async (app) => {
  await app.register(portalAuthRoutes, { prefix: "/auth" });
  await app.register(portalProfileRoutes, { prefix: "/profile" });
  await app.register(portalDoctorsRoutes, { prefix: "/doctors" });
  await app.register(portalDocumentsRoutes, { prefix: "/documents" });
  await app.register(portalClinicalRoutes); // /home, /history, /encounters/:id
};

export default portalRoutes;

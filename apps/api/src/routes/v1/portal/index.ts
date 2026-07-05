import type { FastifyPluginAsync } from "fastify";
import portalAuthRoutes from "./auth.js";
import portalBannersRoutes from "./banners.js";
import portalClinicalRoutes from "./clinical.js";
import portalDoctorsRoutes from "./doctors.js";
import portalDocumentsRoutes from "./documents.js";
import portalFamilyRoutes from "./family.js";
import portalHealthRoutes from "./health.js";
import portalProfileRoutes from "./profile.js";

const portalRoutes: FastifyPluginAsync = async (app) => {
  await app.register(portalAuthRoutes, { prefix: "/auth" });
  await app.register(portalProfileRoutes, { prefix: "/profile" });
  await app.register(portalFamilyRoutes, { prefix: "/family" });
  await app.register(portalDoctorsRoutes, { prefix: "/doctors" });
  await app.register(portalDocumentsRoutes, { prefix: "/documents" });
  await app.register(portalHealthRoutes, { prefix: "/health" });
  await app.register(portalBannersRoutes, { prefix: "/banners" });
  await app.register(portalClinicalRoutes); // /home, /history, /encounters/:id
};

export default portalRoutes;

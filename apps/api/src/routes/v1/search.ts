import type { FastifyPluginAsync } from "fastify";
import { searchPatientsQuerySchema } from "@medsys/validation";
import { parseOrThrowValidation } from "../../lib/http-error.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const searchRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Search", "SearchController", {
    "GET /patients": {
      operationId: "SearchController_searchPatients",
      summary: "Search patients with fuzzy matching and pagination"
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get("/patients", { preHandler: app.authorizePermissions(["patient.read"]) }, async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(searchPatientsQuerySchema, request.query ?? {});

    return app.searchService.searchPatients({
      organizationId: actor.organizationId,
      query: query.q,
      page: query.page ?? 1,
      limit: query.limit ?? 20
    });
  });
};

export default searchRoutes;

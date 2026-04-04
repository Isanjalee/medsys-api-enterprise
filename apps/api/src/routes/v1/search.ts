import type { FastifyPluginAsync } from "fastify";
import { searchPatientsQuerySchema } from "@medsys/validation";
import { parseOrThrowValidation, validationError } from "../../lib/http-error.js";
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
    const resolvedDoctorId =
      query.scope === "my_patients"
        ? query.doctorId ?? (actor.role === "doctor" ? actor.userId : null)
        : query.scope === undefined && actor.role === "doctor"
          ? actor.userId
          : null;

    if (query.scope === "my_patients" && resolvedDoctorId === null) {
      throw validationError([
        {
          field: "doctorId",
          message: "doctorId is required when requesting my_patients outside a doctor session."
        }
      ]);
    }

    return app.searchService.searchPatients({
      organizationId: actor.organizationId,
      query: query.q,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      doctorId: resolvedDoctorId
    });
  });
};

export default searchRoutes;

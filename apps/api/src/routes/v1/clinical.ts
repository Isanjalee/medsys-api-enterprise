import type { FastifyPluginAsync } from "fastify";
import { clinicalIcd10QuerySchema } from "@medsys/validation";
import { applyRouteDocs } from "../../lib/route-docs.js";
import { HttpError, parseOrThrowValidation } from "../../lib/http-error.js";

type ClinicalTablesResponse = [
  number,
  string[],
  Record<string, unknown> | null,
  string[][],
  string[]?
];

const clinicalRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Clinical", "ClinicalController", {
    "GET /icd10": {
      operationId: "ClinicalController_icd10",
      summary: "Search ICD-10 diagnosis suggestions"
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get(
    "/icd10",
    {
      preHandler: app.authorizePermissions(["clinical.icd10.read"]),
      schema: {
        tags: ["Clinical"],
        operationId: "ClinicalController_icd10",
        summary: "Search ICD-10 diagnosis suggestions"
      }
    },
    async (request) => {
      const query = parseOrThrowValidation(clinicalIcd10QuerySchema, request.query ?? {});
      const terms = query.terms ?? "";
      if (terms.length < 2) {
        return { suggestions: [] };
      }

      const url = new URL(app.env.ICD10_API_BASE_URL);
      url.searchParams.set("sf", "code,name");
      url.searchParams.set("df", "code,name");
      url.searchParams.set("terms", terms);
      url.searchParams.set("count", "10");

      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            accept: "application/json"
          }
        });
      } catch (error) {
        request.log.error({ err: error }, "ICD10 provider request failed");
        throw new HttpError(503, "ICD10 provider unavailable");
      }

      if (!response.ok) {
        request.log.error({ status: response.status }, "ICD10 provider returned non-success status");
        throw new HttpError(503, "ICD10 provider unavailable");
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        request.log.error({ err: error }, "ICD10 provider returned invalid JSON");
        throw new HttpError(502, "Invalid ICD10 provider response");
      }

      if (!Array.isArray(payload) || !Array.isArray(payload[3])) {
        throw new HttpError(502, "Invalid ICD10 provider response");
      }

      const suggestions = (payload as ClinicalTablesResponse)[3]
        .filter((row): row is string[] => Array.isArray(row))
        .map((row) => {
          const code = typeof row[0] === "string" ? row[0].trim() : "";
          const name = typeof row[1] === "string" ? row[1].trim() : "";
          return code && name ? `${code} - ${name}` : code || name;
        })
        .filter((value) => value.length > 0);

      return { suggestions };
    }
  );
};

export default clinicalRoutes;

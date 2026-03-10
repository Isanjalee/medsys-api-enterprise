import fp from "fastify-plugin";
import { createSearchService } from "../lib/search-service.js";

const searchPlugin = fp(async (app) => {
  const searchService = createSearchService(app.readDb, app.log, {
    opensearchUrl: app.env.OPENSEARCH_URL,
    patientIndex: app.env.OPENSEARCH_PATIENT_INDEX,
    diagnosisIndex: app.env.OPENSEARCH_DIAGNOSIS_INDEX
  });

  app.decorate("searchService", searchService);
});

export default searchPlugin;

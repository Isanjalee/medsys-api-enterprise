// Doctor-side read access to documents a patient shared. Org-scoped: a clinician
// only ever sees documents whose organization matches their own.
import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { patientDocuments } from "@medsys/db";
import { assertOrThrow } from "../../lib/http-error.js";
import { resolvePagination } from "../../lib/pagination.js";
import { documentsEnabled, presignDownload } from "../../lib/s3.js";

const documentsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get(
    "/patient/:patientId",
    { preHandler: app.authorize(["owner", "doctor", "assistant"]) },
    async (request) => {
      const actor = request.actor!;
      const patientId = Number((request.params as { patientId: string }).patientId);
      assertOrThrow(Number.isInteger(patientId), 400, "Invalid patient id");
      const { limit, offset } = resolvePagination(request.query as { limit?: number; offset?: number });

      return app.readDb
        .select({
          id: patientDocuments.id,
          fileName: patientDocuments.fileName,
          contentType: patientDocuments.contentType,
          sizeBytes: patientDocuments.sizeBytes,
          uploadedAt: patientDocuments.uploadedAt,
          status: patientDocuments.status
        })
        .from(patientDocuments)
        .where(
          and(
            eq(patientDocuments.organizationId, actor.organizationId),
            eq(patientDocuments.patientId, patientId)
          )
        )
        .orderBy(desc(patientDocuments.uploadedAt))
        .limit(limit)
        .offset(offset);
    }
  );

  app.get(
    "/:id/download-url",
    { preHandler: app.authorize(["owner", "doctor", "assistant"]) },
    async (request) => {
      assertOrThrow(documentsEnabled(app.env), 503, "Document storage is not configured");
      const actor = request.actor!;
      const id = Number((request.params as { id: string }).id);
      assertOrThrow(Number.isInteger(id), 400, "Invalid document id");

      const rows = await app.readDb
        .select({ s3Key: patientDocuments.s3Key, fileName: patientDocuments.fileName })
        .from(patientDocuments)
        .where(and(eq(patientDocuments.id, id), eq(patientDocuments.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(rows.length === 1, 404, "Document not found");
      return { url: await presignDownload(app.env, rows[0].s3Key, rows[0].fileName) };
    }
  );
};

export default documentsRoutes;

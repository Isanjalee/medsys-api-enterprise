// Document access for clinic staff. Org-scoped: a clinician only ever sees documents
// whose organization matches their own. Supports both patient-portal self-uploads and
// staff (assistant/doctor) uploads, unified in patient_documents.
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { aliasedTable, and, desc, eq } from "drizzle-orm";
import { patientDocuments, patients, users } from "@medsys/db";
import { assertOrThrow } from "../../lib/http-error.js";
import { buildDisplayName } from "../../lib/names.js";
import { resolvePagination } from "../../lib/pagination.js";
import {
  ALLOWED_DOCUMENT_TYPES,
  buildDocumentKey,
  getDocument,
  putDocument
} from "../../lib/s3.js";

const STAFF_ROLES = ["owner", "doctor", "assistant"] as const;

const documentsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // Documents for one patient (both portal self-uploads and staff uploads).
  app.get(
    "/patient/:patientId",
    { preHandler: app.authorize([...STAFF_ROLES]) },
    async (request) => {
      const actor = request.actor!;
      const patientId = Number((request.params as { patientId: string }).patientId);
      assertOrThrow(Number.isInteger(patientId), 400, "Invalid patient id");
      const { limit, offset } = resolvePagination(request.query as { limit?: number; offset?: number });

      const uploader = aliasedTable(users, "uploader");
      const rows = await app.readDb
        .select({
          id: patientDocuments.id,
          fileName: patientDocuments.fileName,
          contentType: patientDocuments.contentType,
          sizeBytes: patientDocuments.sizeBytes,
          uploadedAt: patientDocuments.uploadedAt,
          status: patientDocuments.status,
          source: patientDocuments.source,
          note: patientDocuments.note,
          uploadedByFirst: uploader.firstName,
          uploadedByLast: uploader.lastName
        })
        .from(patientDocuments)
        .leftJoin(uploader, eq(uploader.id, patientDocuments.uploadedByUserId))
        .where(
          and(
            eq(patientDocuments.organizationId, actor.organizationId),
            eq(patientDocuments.patientId, patientId)
          )
        )
        .orderBy(desc(patientDocuments.uploadedAt))
        .limit(limit)
        .offset(offset);

      return rows.map((row) => ({
        id: row.id,
        fileName: row.fileName,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        uploadedAt: row.uploadedAt,
        status: row.status,
        source: row.source,
        note: row.note,
        uploadedByName:
          row.uploadedByFirst || row.uploadedByLast
            ? buildDisplayName(row.uploadedByFirst ?? "", row.uploadedByLast ?? "")
            : row.source === "patient"
              ? "Patient"
              : null
      }));
    }
  );

  // Staff upload a document for a clinic patient (e.g. an external test report the
  // assistant received). Bytes proxied to storage; note is an optional query param so
  // we never depend on multipart field ordering.
  app.post(
    "/patient/:patientId",
    { preHandler: app.authorize([...STAFF_ROLES]) },
    async (request, reply) => {
      const actor = request.actor!;
      const patientId = Number((request.params as { patientId: string }).patientId);
      assertOrThrow(Number.isInteger(patientId), 400, "Invalid patient id");

      const patientRows = await app.db
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.id, patientId), eq(patients.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(patientRows.length === 1, 404, "Patient not found");

      const rawNote = (request.query as { note?: string }).note;
      const note = typeof rawNote === "string" && rawNote.trim() ? rawNote.trim().slice(0, 1000) : null;

      const file = await (request as unknown as { file: () => Promise<any> }).file();
      assertOrThrow(file, 400, "No file uploaded");
      assertOrThrow(ALLOWED_DOCUMENT_TYPES.has(file.mimetype), 415, "Only PDF, JPG and PNG files are allowed");

      const buffer: Buffer = await file.toBuffer();
      assertOrThrow(buffer.length > 0, 400, "Empty file");
      assertOrThrow(buffer.length <= app.env.PATIENT_DOCUMENT_MAX_BYTES, 413, "File is too large");

      const uuid = randomUUID();
      const fileName = String(file.filename ?? "document").slice(0, 255);
      const key = buildDocumentKey(actor.organizationId, patientId, uuid, fileName);
      await putDocument(app.env, key, buffer, file.mimetype);

      const inserted = await app.db
        .insert(patientDocuments)
        .values({
          uuid,
          organizationId: actor.organizationId,
          patientId,
          uploadedByUserId: actor.userId,
          source: "assistant",
          note,
          fileName,
          contentType: file.mimetype,
          sizeBytes: buffer.length,
          s3Key: key,
          status: "shared"
        })
        .returning({ id: patientDocuments.id, uploadedAt: patientDocuments.uploadedAt });

      return reply.code(201).send({ id: inserted[0].id, uploadedAt: inserted[0].uploadedAt });
    }
  );

  // Org-wide review queue: recent documents with the patient + uploader details the
  // doctor needs to triage them. Defaults to staff uploads (the report-review inbox).
  app.get(
    "/review",
    { preHandler: app.authorize([...STAFF_ROLES]) },
    async (request) => {
      const actor = request.actor!;
      const query = request.query as { limit?: number; offset?: number; source?: string };
      const { limit, offset } = resolvePagination(query);
      const sourceFilter = query.source === "patient" || query.source === "assistant" ? query.source : "assistant";

      const uploader = aliasedTable(users, "uploader");
      const rows = await app.readDb
        .select({
          id: patientDocuments.id,
          fileName: patientDocuments.fileName,
          contentType: patientDocuments.contentType,
          sizeBytes: patientDocuments.sizeBytes,
          uploadedAt: patientDocuments.uploadedAt,
          source: patientDocuments.source,
          note: patientDocuments.note,
          patientId: patientDocuments.patientId,
          patientFirst: patients.firstName,
          patientLast: patients.lastName,
          patientCode: patients.patientCode,
          patientNic: patients.nic,
          patientPhone: patients.phone,
          patientAge: patients.age,
          patientDob: patients.dob,
          patientGender: patients.gender,
          uploadedByFirst: uploader.firstName,
          uploadedByLast: uploader.lastName
        })
        .from(patientDocuments)
        .innerJoin(patients, eq(patients.id, patientDocuments.patientId))
        .leftJoin(uploader, eq(uploader.id, patientDocuments.uploadedByUserId))
        .where(
          and(
            eq(patientDocuments.organizationId, actor.organizationId),
            eq(patientDocuments.source, sourceFilter)
          )
        )
        .orderBy(desc(patientDocuments.uploadedAt))
        .limit(limit)
        .offset(offset);

      return rows.map((row) => ({
        id: row.id,
        fileName: row.fileName,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        uploadedAt: row.uploadedAt,
        source: row.source,
        note: row.note,
        patientId: row.patientId,
        patientName: buildDisplayName(row.patientFirst, row.patientLast),
        patientCode: row.patientCode,
        patientNic: row.patientNic,
        patientPhone: row.patientPhone,
        patientAge: row.patientAge,
        patientDob: row.patientDob,
        patientGender: row.patientGender,
        uploadedByName:
          row.uploadedByFirst || row.uploadedByLast
            ? buildDisplayName(row.uploadedByFirst ?? "", row.uploadedByLast ?? "")
            : null
      }));
    }
  );

  // Stream a document inline (works for both S3 and local-filesystem storage). Used by
  // the frontend "Open" action, which navigates a new tab to this route.
  app.get(
    "/:id/raw",
    { preHandler: app.authorize([...STAFF_ROLES]) },
    async (request, reply) => {
      const actor = request.actor!;
      const id = Number((request.params as { id: string }).id);
      assertOrThrow(Number.isInteger(id), 400, "Invalid document id");

      const rows = await app.readDb
        .select({
          s3Key: patientDocuments.s3Key,
          fileName: patientDocuments.fileName,
          contentType: patientDocuments.contentType
        })
        .from(patientDocuments)
        .where(and(eq(patientDocuments.id, id), eq(patientDocuments.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(rows.length === 1, 404, "Document not found");

      const buffer = await getDocument(app.env, rows[0].s3Key);
      const safeName = rows[0].fileName.replace(/"/g, "");
      return reply
        .header("Content-Type", rows[0].contentType)
        .header("Content-Disposition", `inline; filename="${safeName}"`)
        .header("Cache-Control", "private, max-age=60")
        .send(buffer);
    }
  );
};

export default documentsRoutes;

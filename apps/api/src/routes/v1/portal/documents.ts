import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { patientDoctorLinks, patientDocuments, organizations, users } from "@medsys/db";
import { portalDocumentCreateSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../../lib/http-error.js";
import { buildDisplayName } from "../../../lib/names.js";
import {
  ALLOWED_DOCUMENT_TYPES,
  buildDocumentKey,
  documentsEnabled,
  getDocument,
  presignDownload,
  putDocument,
  supportsPresignedUrls
} from "../../../lib/s3.js";

const portalDocumentsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticatePatient);

  // Upload a document and share it to a linked doctor. doctorUserId is a query param
  // so we never depend on multipart field ordering. Bytes are proxied to S3.
  app.post("/", async (request, reply) => {
    assertOrThrow(documentsEnabled(app.env), 503, "Document storage is not configured");
    const accountId = request.patientActor!.patientAccountId;
    const { doctorUserId } = parseOrThrowValidation(portalDocumentCreateSchema, request.query);

    const link = await app.db
      .select({ organizationId: patientDoctorLinks.organizationId, patientId: patientDoctorLinks.patientId })
      .from(patientDoctorLinks)
      .where(and(eq(patientDoctorLinks.patientAccountId, accountId), eq(patientDoctorLinks.doctorUserId, doctorUserId)))
      .limit(1);
    assertOrThrow(link.length === 1, 404, "You are not linked to that doctor");

    const file = await (request as unknown as { file: () => Promise<any> }).file();
    assertOrThrow(file, 400, "No file uploaded");
    assertOrThrow(ALLOWED_DOCUMENT_TYPES.has(file.mimetype), 415, "Only PDF, JPG and PNG files are allowed");

    const buffer: Buffer = await file.toBuffer();
    assertOrThrow(buffer.length > 0, 400, "Empty file");
    assertOrThrow(buffer.length <= app.env.PATIENT_DOCUMENT_MAX_BYTES, 413, "File is too large");

    const uuid = randomUUID();
    const fileName = String(file.filename ?? "document").slice(0, 255);
    const key = buildDocumentKey(link[0].organizationId, link[0].patientId, uuid, fileName);
    await putDocument(app.env, key, buffer, file.mimetype);

    const inserted = await app.db
      .insert(patientDocuments)
      .values({
        uuid,
        patientAccountId: accountId,
        organizationId: link[0].organizationId,
        patientId: link[0].patientId,
        doctorUserId,
        fileName,
        contentType: file.mimetype,
        sizeBytes: buffer.length,
        s3Key: key,
        status: "shared"
      })
      .returning();

    return reply.code(201).send(inserted[0]);
  });

  // The patient's own uploaded documents.
  app.get("/", async (request) => {
    const rows = await app.readDb
      .select({
        id: patientDocuments.id,
        fileName: patientDocuments.fileName,
        contentType: patientDocuments.contentType,
        sizeBytes: patientDocuments.sizeBytes,
        uploadedAt: patientDocuments.uploadedAt,
        doctorUserId: patientDocuments.doctorUserId,
        doctorFirst: users.firstName,
        doctorLast: users.lastName,
        clinicName: organizations.name
      })
      .from(patientDocuments)
      .innerJoin(users, eq(users.id, patientDocuments.doctorUserId))
      .innerJoin(organizations, eq(organizations.id, patientDocuments.organizationId))
      .where(eq(patientDocuments.patientAccountId, request.patientActor!.patientAccountId))
      .orderBy(desc(patientDocuments.uploadedAt));

    return rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      uploadedAt: row.uploadedAt,
      doctorName: buildDisplayName(row.doctorFirst, row.doctorLast),
      clinicName: row.clinicName
    }));
  });

  // URL so the patient can re-open a document they uploaded. Presigned S3 link when
  // S3 is configured; otherwise a relative path to the raw-stream route below.
  app.get("/:id/download-url", async (request) => {
    const id = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(id), 400, "Invalid document id");
    const rows = await app.readDb
      .select({ s3Key: patientDocuments.s3Key, fileName: patientDocuments.fileName })
      .from(patientDocuments)
      .where(and(eq(patientDocuments.id, id), eq(patientDocuments.patientAccountId, request.patientActor!.patientAccountId)))
      .limit(1);
    assertOrThrow(rows.length === 1, 404, "Document not found");
    if (supportsPresignedUrls(app.env)) {
      return { url: await presignDownload(app.env, rows[0].s3Key, rows[0].fileName) };
    }
    return { url: `/api/portal/documents/${id}/raw` };
  });

  // Stream a patient's own document inline (local-filesystem mode, or a uniform path).
  app.get("/:id/raw", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(id), 400, "Invalid document id");
    const rows = await app.readDb
      .select({
        s3Key: patientDocuments.s3Key,
        fileName: patientDocuments.fileName,
        contentType: patientDocuments.contentType
      })
      .from(patientDocuments)
      .where(and(eq(patientDocuments.id, id), eq(patientDocuments.patientAccountId, request.patientActor!.patientAccountId)))
      .limit(1);
    assertOrThrow(rows.length === 1, 404, "Document not found");
    const buffer = await getDocument(app.env, rows[0].s3Key);
    const safeName = rows[0].fileName.replace(/"/g, "");
    return reply
      .header("Content-Type", rows[0].contentType)
      .header("Content-Disposition", `inline; filename="${safeName}"`)
      .header("Cache-Control", "private, max-age=60")
      .send(buffer);
  });
};

export default portalDocumentsRoutes;

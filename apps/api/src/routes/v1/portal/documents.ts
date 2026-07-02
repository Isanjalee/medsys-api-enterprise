import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { aliasedTable, and, desc, eq, inArray, isNull } from "drizzle-orm";
import { patientDoctorLinks, patientDocuments, organizations, patients, users } from "@medsys/db";
import { portalDocumentCreateSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../../lib/http-error.js";
import { buildDisplayName } from "../../../lib/names.js";
import {
  buildDocumentKey,
  getDocument,
  presignDownload,
  putDocument,
  resolveDocumentContentType,
  supportsPresignedUrls
} from "../../../lib/s3.js";

const portalDocumentsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticatePatient);

  // The clinic patient ids this account can read — only the charts it has explicitly linked
  // or claimed (owner + members it added + NIC/DOB-matched). Not expanded to the whole clinic
  // family, so a separate individual account sees only its own person's documents.
  const linkedPatientIds = async (accountId: number): Promise<number[]> => {
    const rows = await app.readDb
      .select({ patientId: patientDoctorLinks.patientId })
      .from(patientDoctorLinks)
      .where(eq(patientDoctorLinks.patientAccountId, accountId));
    return [...new Set(rows.map((row) => row.patientId))];
  };

  // Upload a document and share it to a linked doctor. doctorUserId is a query param
  // so we never depend on multipart field ordering. Bytes are proxied to storage.
  app.post("/", async (request, reply) => {
    const accountId = request.patientActor!.patientAccountId;
    const { doctorUserId, memberId } = parseOrThrowValidation(portalDocumentCreateSchema, request.query);

    // Resolve the specific profile→doctor link (defaults to the account holder's link).
    const link = await app.db
      .select({ organizationId: patientDoctorLinks.organizationId, patientId: patientDoctorLinks.patientId })
      .from(patientDoctorLinks)
      .where(
        and(
          eq(patientDoctorLinks.patientAccountId, accountId),
          eq(patientDoctorLinks.doctorUserId, doctorUserId),
          memberId != null ? eq(patientDoctorLinks.memberId, memberId) : isNull(patientDoctorLinks.memberId)
        )
      )
      .limit(1);
    assertOrThrow(link.length === 1, 404, "That profile is not linked to this doctor");

    const file = await (request as unknown as { file: () => Promise<any> }).file();
    assertOrThrow(file, 400, "No file uploaded");
    const fileName = String(file.filename ?? "document").slice(0, 255);
    const contentType = resolveDocumentContentType(file.mimetype, fileName);
    assertOrThrow(contentType, 415, "Only PDF and image files (PDF, JPG, PNG, HEIC) are allowed");

    const buffer: Buffer = await file.toBuffer();
    assertOrThrow(buffer.length > 0, 400, "Empty file");
    assertOrThrow(buffer.length <= app.env.PATIENT_DOCUMENT_MAX_BYTES, 413, "File is too large");

    const uuid = randomUUID();
    const key = buildDocumentKey(link[0].organizationId, link[0].patientId, uuid, fileName);
    await putDocument(app.env, key, buffer, contentType!);

    const inserted = await app.db
      .insert(patientDocuments)
      .values({
        uuid,
        patientAccountId: accountId,
        organizationId: link[0].organizationId,
        patientId: link[0].patientId,
        doctorUserId,
        source: "patient",
        fileName,
        contentType: contentType!,
        sizeBytes: buffer.length,
        s3Key: key,
        status: "shared"
      })
      .returning({ id: patientDocuments.id, uploadedAt: patientDocuments.uploadedAt });

    return reply.code(201).send(inserted[0]);
  });

  // Documents the patient sent to their doctors (own uploads), with review status so the
  // patient can see when a doctor has reviewed their report.
  app.get("/", async (request) => {
    const rows = await app.readDb
      .select({
        id: patientDocuments.id,
        fileName: patientDocuments.fileName,
        contentType: patientDocuments.contentType,
        sizeBytes: patientDocuments.sizeBytes,
        uploadedAt: patientDocuments.uploadedAt,
        reviewedAt: patientDocuments.reviewedAt,
        doctorUserId: patientDocuments.doctorUserId,
        doctorFirst: users.firstName,
        doctorLast: users.lastName,
        clinicName: organizations.name,
        profileFirst: patients.firstName,
        profileLast: patients.lastName
      })
      .from(patientDocuments)
      .innerJoin(users, eq(users.id, patientDocuments.doctorUserId))
      .innerJoin(organizations, eq(organizations.id, patientDocuments.organizationId))
      .leftJoin(patients, eq(patients.id, patientDocuments.patientId))
      .where(eq(patientDocuments.patientAccountId, request.patientActor!.patientAccountId))
      .orderBy(desc(patientDocuments.uploadedAt));

    return rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      uploadedAt: row.uploadedAt,
      reviewedAt: row.reviewedAt,
      doctorName: buildDisplayName(row.doctorFirst, row.doctorLast),
      clinicName: row.clinicName,
      // Which family profile this document was sent for.
      profileName: buildDisplayName(row.profileFirst ?? "", row.profileLast ?? "")
    }));
  });

  // Documents the clinic (doctor/assistant) shared TO the patient — e.g. test results.
  // These live on the patient's linked clinic records (source = assistant).
  app.get("/received", async (request) => {
    const accountId = request.patientActor!.patientAccountId;
    const patientIds = await linkedPatientIds(accountId);
    if (patientIds.length === 0) return [];

    const uploader = aliasedTable(users, "uploader");
    const rows = await app.readDb
      .select({
        id: patientDocuments.id,
        fileName: patientDocuments.fileName,
        contentType: patientDocuments.contentType,
        sizeBytes: patientDocuments.sizeBytes,
        uploadedAt: patientDocuments.uploadedAt,
        reviewedAt: patientDocuments.reviewedAt,
        note: patientDocuments.note,
        uploadedByFirst: uploader.firstName,
        uploadedByLast: uploader.lastName,
        clinicName: organizations.name
      })
      .from(patientDocuments)
      .innerJoin(organizations, eq(organizations.id, patientDocuments.organizationId))
      .leftJoin(uploader, eq(uploader.id, patientDocuments.uploadedByUserId))
      .where(and(inArray(patientDocuments.patientId, patientIds), eq(patientDocuments.source, "assistant")))
      .orderBy(desc(patientDocuments.uploadedAt));

    return rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      uploadedAt: row.uploadedAt,
      reviewedAt: row.reviewedAt,
      note: row.note,
      uploadedByName:
        row.uploadedByFirst || row.uploadedByLast ? buildDisplayName(row.uploadedByFirst ?? "", row.uploadedByLast ?? "") : "Clinic",
      clinicName: row.clinicName
    }));
  });

  // Resolve a document the patient may open: either one they uploaded, or one shared to
  // a clinic record they're linked to.
  const loadAccessibleDoc = async (accountId: number, id: number) => {
    const patientIds = await linkedPatientIds(accountId);
    const rows = await app.readDb
      .select({
        id: patientDocuments.id,
        s3Key: patientDocuments.s3Key,
        fileName: patientDocuments.fileName,
        contentType: patientDocuments.contentType,
        patientAccountId: patientDocuments.patientAccountId,
        patientId: patientDocuments.patientId
      })
      .from(patientDocuments)
      .where(eq(patientDocuments.id, id))
      .limit(1);
    if (rows.length !== 1) return null;
    const doc = rows[0];
    const owns = doc.patientAccountId === accountId;
    const shared = doc.patientId != null && patientIds.includes(doc.patientId);
    return owns || shared ? doc : null;
  };

  // URL so the patient can open a document. Presigned S3 link when S3 is configured;
  // otherwise a relative path to the raw-stream route below.
  app.get("/:id/download-url", async (request) => {
    const id = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(id), 400, "Invalid document id");
    const doc = await loadAccessibleDoc(request.patientActor!.patientAccountId, id);
    assertOrThrow(doc, 404, "Document not found");
    if (supportsPresignedUrls(app.env)) {
      return { url: await presignDownload(app.env, doc!.s3Key, doc!.fileName) };
    }
    return { url: `/api/portal/documents/${id}/raw` };
  });

  // Stream a document the patient can access inline.
  app.get("/:id/raw", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(id), 400, "Invalid document id");
    const doc = await loadAccessibleDoc(request.patientActor!.patientAccountId, id);
    assertOrThrow(doc, 404, "Document not found");
    const buffer = await getDocument(app.env, doc!.s3Key);
    const safeName = doc!.fileName.replace(/"/g, "");
    return reply
      .header("Content-Type", doc!.contentType)
      .header("Content-Disposition", `inline; filename="${safeName}"`)
      .header("Cache-Control", "private, max-age=60")
      .send(buffer);
  });
};

export default portalDocumentsRoutes;

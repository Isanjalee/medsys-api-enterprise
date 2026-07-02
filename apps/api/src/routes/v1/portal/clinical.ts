import type { FastifyPluginAsync } from "fastify";
import { aliasedTable, and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  encounterDiagnoses,
  encounters,
  organizations,
  patientAccountMembers,
  patientDoctorLinks,
  patientDocuments,
  prescriptionItems,
  prescriptions,
  testOrders,
  users
} from "@medsys/db";
import { assertOrThrow } from "../../../lib/http-error.js";
import { buildDisplayName } from "../../../lib/names.js";
import { resolvePagination } from "../../../lib/pagination.js";

type LinkContext = {
  patientIds: number[];
  byPatientId: Map<number, { clinicName: string; doctorName: string; organizationId: string }>;
};

const portalClinicalRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticatePatient);

  const loadLinks = async (accountId: number): Promise<LinkContext> => {
    const rows = await app.readDb
      .select({
        patientId: patientDoctorLinks.patientId,
        organizationId: patientDoctorLinks.organizationId,
        clinicName: organizations.name,
        firstName: users.firstName,
        lastName: users.lastName
      })
      .from(patientDoctorLinks)
      .innerJoin(organizations, eq(organizations.id, patientDoctorLinks.organizationId))
      .innerJoin(users, eq(users.id, patientDoctorLinks.doctorUserId))
      .where(eq(patientDoctorLinks.patientAccountId, accountId));

    const byPatientId = new Map<number, { clinicName: string; doctorName: string; organizationId: string }>();
    for (const row of rows) {
      byPatientId.set(row.patientId, {
        clinicName: row.clinicName,
        doctorName: buildDisplayName(row.firstName, row.lastName),
        organizationId: row.organizationId
      });
    }

    // Only the charts this account has explicitly linked or claimed (owner + members it added
    // + NIC/DOB-matched charts). We do NOT expand to the whole clinic family: a separate
    // individual account must see only its own person's records, not everyone grouped with
    // them at the clinic.
    return { patientIds: [...byPatientId.keys()], byPatientId };
  };

  // Links for a SINGLE profile (the account holder when memberId is null, else one family
  // member). Unlike loadLinks this does NOT expand to the whole family — it returns only the
  // clinic records that belong to that specific profile, so the per-profile view stays scoped.
  const loadProfileLinks = async (accountId: number, memberId: number | null): Promise<LinkContext> => {
    const rows = await app.readDb
      .select({
        patientId: patientDoctorLinks.patientId,
        organizationId: patientDoctorLinks.organizationId,
        clinicName: organizations.name,
        firstName: users.firstName,
        lastName: users.lastName
      })
      .from(patientDoctorLinks)
      .innerJoin(organizations, eq(organizations.id, patientDoctorLinks.organizationId))
      .innerJoin(users, eq(users.id, patientDoctorLinks.doctorUserId))
      .where(
        and(
          eq(patientDoctorLinks.patientAccountId, accountId),
          memberId != null ? eq(patientDoctorLinks.memberId, memberId) : isNull(patientDoctorLinks.memberId)
        )
      );

    const byPatientId = new Map<number, { clinicName: string; doctorName: string; organizationId: string }>();
    for (const row of rows) {
      byPatientId.set(row.patientId, {
        clinicName: row.clinicName,
        doctorName: buildDisplayName(row.firstName, row.lastName),
        organizationId: row.organizationId
      });
    }
    return { patientIds: [...byPatientId.keys()], byPatientId };
  };

  // Build the diagnosis/visit timeline for a set of clinic records.
  const buildTimeline = async (ctx: LinkContext) => {
    if (ctx.patientIds.length === 0) return [];
    const visitRows = await app.readDb
      .select({
        encounterId: encounters.id,
        patientId: encounters.patientId,
        checkedAt: encounters.checkedAt,
        notes: encounters.notes,
        nextVisitDate: encounters.nextVisitDate
      })
      .from(encounters)
      .where(and(inArray(encounters.patientId, ctx.patientIds), eq(encounters.status, "completed")))
      .orderBy(desc(encounters.checkedAt))
      .limit(100);

    const encounterIds = visitRows.map((row) => row.encounterId);
    const diagnosisRows = encounterIds.length
      ? await app.readDb
          .select({ encounterId: encounterDiagnoses.encounterId, diagnosisName: encounterDiagnoses.diagnosisName })
          .from(encounterDiagnoses)
          .where(inArray(encounterDiagnoses.encounterId, encounterIds))
      : [];
    const diagByEncounter = new Map<number, string[]>();
    for (const row of diagnosisRows) {
      const list = diagByEncounter.get(row.encounterId) ?? [];
      list.push(row.diagnosisName);
      diagByEncounter.set(row.encounterId, list);
    }

    return visitRows.map((row) => {
      const meta = ctx.byPatientId.get(row.patientId);
      return {
        encounterId: row.encounterId,
        date: row.checkedAt,
        clinicName: meta?.clinicName ?? null,
        doctorName: meta?.doctorName ?? null,
        diagnoses: diagByEncounter.get(row.encounterId) ?? [],
        notes: row.notes ?? null,
        nextVisitDate: row.nextVisitDate ?? null
      };
    });
  };

  // Home: diagnosis/visit timeline aggregated across every linked clinic record.
  app.get("/home", async (request) => {
    const ctx = await loadLinks(request.patientActor!.patientAccountId);
    return { timeline: await buildTimeline(ctx) };
  });

  // Per-profile view: one family member's (or the account holder's) diagnoses plus the
  // documents sent to and received from their clinics — kept separate from the family-wide
  // aggregate so the Home grid can drill into a single profile.
  app.get("/profiles/:memberId/summary", async (request) => {
    const accountId = request.patientActor!.patientAccountId;
    const raw = (request.params as { memberId: string }).memberId;
    const memberId = raw === "self" ? null : Number(raw);
    assertOrThrow(raw === "self" || Number.isInteger(memberId), 400, "Invalid profile");

    // Guard: a numeric memberId must belong to this account.
    if (memberId != null) {
      const owned = await app.readDb
        .select({ id: patientAccountMembers.id })
        .from(patientAccountMembers)
        .where(and(eq(patientAccountMembers.id, memberId), eq(patientAccountMembers.patientAccountId, accountId)))
        .limit(1);
      assertOrThrow(owned.length === 1, 404, "Profile not found");
    }

    const ctx = await loadProfileLinks(accountId, memberId);
    if (ctx.patientIds.length === 0) return { timeline: [], sentDocuments: [], receivedDocuments: [] };

    const uploader = aliasedTable(users, "uploader");
    const [timeline, sentRows, receivedRows] = await Promise.all([
      buildTimeline(ctx),
      app.readDb
        .select({
          id: patientDocuments.id,
          fileName: patientDocuments.fileName,
          contentType: patientDocuments.contentType,
          sizeBytes: patientDocuments.sizeBytes,
          uploadedAt: patientDocuments.uploadedAt,
          reviewedAt: patientDocuments.reviewedAt,
          doctorFirst: users.firstName,
          doctorLast: users.lastName,
          clinicName: organizations.name
        })
        .from(patientDocuments)
        .innerJoin(users, eq(users.id, patientDocuments.doctorUserId))
        .innerJoin(organizations, eq(organizations.id, patientDocuments.organizationId))
        .where(and(inArray(patientDocuments.patientId, ctx.patientIds), eq(patientDocuments.source, "patient")))
        .orderBy(desc(patientDocuments.uploadedAt)),
      app.readDb
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
        .where(and(inArray(patientDocuments.patientId, ctx.patientIds), eq(patientDocuments.source, "assistant")))
        .orderBy(desc(patientDocuments.uploadedAt))
    ]);

    return {
      timeline,
      sentDocuments: sentRows.map((row) => ({
        id: row.id,
        fileName: row.fileName,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        uploadedAt: row.uploadedAt,
        reviewedAt: row.reviewedAt,
        doctorName: buildDisplayName(row.doctorFirst, row.doctorLast),
        clinicName: row.clinicName
      })),
      receivedDocuments: receivedRows.map((row) => ({
        id: row.id,
        fileName: row.fileName,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        uploadedAt: row.uploadedAt,
        reviewedAt: row.reviewedAt,
        note: row.note,
        uploadedByName:
          row.uploadedByFirst || row.uploadedByLast
            ? buildDisplayName(row.uploadedByFirst ?? "", row.uploadedByLast ?? "")
            : "Clinic",
        clinicName: row.clinicName
      }))
    };
  });

  // History: prescription summary cards.
  app.get("/history", async (request) => {
    const ctx = await loadLinks(request.patientActor!.patientAccountId);
    if (ctx.patientIds.length === 0) return [];
    const { limit, offset } = resolvePagination(request.query as { limit?: number; offset?: number });

    const rows = await app.readDb
      .select({
        prescriptionId: prescriptions.id,
        encounterId: prescriptions.encounterId,
        patientId: prescriptions.patientId,
        createdAt: prescriptions.createdAt,
        checkedAt: encounters.checkedAt
      })
      .from(prescriptions)
      .innerJoin(encounters, eq(encounters.id, prescriptions.encounterId))
      .where(inArray(prescriptions.patientId, ctx.patientIds))
      .orderBy(desc(encounters.checkedAt))
      .limit(limit)
      .offset(offset);

    const prescriptionIds = rows.map((row) => row.prescriptionId);
    const itemRows = prescriptionIds.length
      ? await app.readDb
          .select({ prescriptionId: prescriptionItems.prescriptionId, drugName: prescriptionItems.drugName })
          .from(prescriptionItems)
          .where(inArray(prescriptionItems.prescriptionId, prescriptionIds))
      : [];
    const itemsByPrescription = new Map<number, string[]>();
    for (const row of itemRows) {
      const list = itemsByPrescription.get(row.prescriptionId) ?? [];
      list.push(row.drugName);
      itemsByPrescription.set(row.prescriptionId, list);
    }

    return rows.map((row) => {
      const meta = ctx.byPatientId.get(row.patientId);
      const drugs = itemsByPrescription.get(row.prescriptionId) ?? [];
      return {
        prescriptionId: row.prescriptionId,
        encounterId: row.encounterId,
        date: row.checkedAt,
        clinicName: meta?.clinicName ?? null,
        doctorName: meta?.doctorName ?? null,
        drugCount: drugs.length,
        drugPreview: drugs.slice(0, 3)
      };
    });
  });

  // Full detail for one encounter the patient owns.
  app.get("/encounters/:id", async (request) => {
    const ctx = await loadLinks(request.patientActor!.patientAccountId);
    const encounterId = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(encounterId), 400, "Invalid encounter id");
    if (ctx.patientIds.length === 0) assertOrThrow(false, 404, "Encounter not found");

    const found = await app.readDb
      .select()
      .from(encounters)
      .where(and(eq(encounters.id, encounterId), inArray(encounters.patientId, ctx.patientIds)))
      .limit(1);
    assertOrThrow(found.length === 1, 404, "Encounter not found");

    const [diagnoses, tests, prescriptionRows] = await Promise.all([
      app.readDb.select().from(encounterDiagnoses).where(eq(encounterDiagnoses.encounterId, encounterId)),
      app.readDb.select().from(testOrders).where(eq(testOrders.encounterId, encounterId)),
      app.readDb.select().from(prescriptions).where(eq(prescriptions.encounterId, encounterId))
    ]);
    const prescriptionIds = prescriptionRows.map((row) => row.id);
    const items = prescriptionIds.length
      ? await app.readDb
          .select()
          .from(prescriptionItems)
          .where(inArray(prescriptionItems.prescriptionId, prescriptionIds))
      : [];

    const meta = ctx.byPatientId.get(found[0].patientId);
    return {
      encounter: found[0],
      clinicName: meta?.clinicName ?? null,
      doctorName: meta?.doctorName ?? null,
      diagnoses,
      tests,
      prescriptionItems: items
    };
  });
};

export default portalClinicalRoutes;

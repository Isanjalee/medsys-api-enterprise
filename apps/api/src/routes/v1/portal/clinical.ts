import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  encounterDiagnoses,
  encounters,
  organizations,
  patientDoctorLinks,
  patients,
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
    const ctxByOrg = new Map<string, { clinicName: string; doctorName: string; organizationId: string }>();
    for (const row of rows) {
      const ctx = {
        clinicName: row.clinicName,
        doctorName: buildDisplayName(row.firstName, row.lastName),
        organizationId: row.organizationId
      };
      byPatientId.set(row.patientId, ctx);
      if (!ctxByOrg.has(row.organizationId)) ctxByOrg.set(row.organizationId, ctx);
    }

    // Expand to the whole family: every clinic patient sharing a family with a linked
    // record (so the account sees all family members' history and reports).
    const ownerPatientIds = [...byPatientId.keys()];
    if (ownerPatientIds.length > 0) {
      const ownerRows = await app.readDb
        .select({ familyId: patients.familyId })
        .from(patients)
        .where(inArray(patients.id, ownerPatientIds));
      const familyIds = [...new Set(ownerRows.map((r) => r.familyId).filter((v): v is number => v !== null))];
      if (familyIds.length > 0) {
        const memberRows = await app.readDb
          .select({ id: patients.id, organizationId: patients.organizationId })
          .from(patients)
          .where(and(inArray(patients.familyId, familyIds), isNull(patients.deletedAt)));
        for (const member of memberRows) {
          if (byPatientId.has(member.id)) continue;
          const ctx = ctxByOrg.get(member.organizationId);
          if (ctx) byPatientId.set(member.id, ctx);
        }
      }
    }

    return { patientIds: [...byPatientId.keys()], byPatientId };
  };

  // Home: diagnosis/visit timeline aggregated across every linked clinic record.
  app.get("/home", async (request) => {
    const ctx = await loadLinks(request.patientActor!.patientAccountId);
    if (ctx.patientIds.length === 0) return { timeline: [] };

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

    const timeline = visitRows.map((row) => {
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

    return { timeline };
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

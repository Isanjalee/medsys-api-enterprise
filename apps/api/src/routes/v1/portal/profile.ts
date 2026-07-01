import type { FastifyPluginAsync } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { patientAccounts, patientDoctorLinks, patients } from "@medsys/db";
import { portalProfileSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../../lib/http-error.js";

const ageFromDob = (dob: string): number => {
  const birth = new Date(`${dob}T00:00:00Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return Math.max(0, Math.min(age, 130));
};

const portalProfileRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticatePatient);

  app.get("/", async (request) => {
    const rows = await app.db
      .select()
      .from(patientAccounts)
      .where(eq(patientAccounts.id, request.patientActor!.patientAccountId))
      .limit(1);
    assertOrThrow(rows.length === 1, 404, "Account not found");
    return rows[0];
  });

  // Onboarding pre-fill: if the NIC (preferred) or phone matches an existing clinic
  // chart, return its profile fields so the wizard can fill the blanks. Clinical history
  // is only exposed after the patient links a doctor (which auto-merges to the chart).
  app.get("/match", async (request) => {
    const query = request.query as { nic?: string; phone?: string };
    const nic = query.nic?.trim() || null;
    const phone = query.phone?.trim() || null;
    if (!nic && !phone) return { matched: false };

    const fields = {
      firstName: patients.firstName,
      lastName: patients.lastName,
      dob: patients.dob,
      gender: patients.gender,
      phone: patients.phone,
      address: patients.address,
      bloodGroup: patients.bloodGroup
    };
    const find = async (column: typeof patients.nic | typeof patients.phone, value: string) => {
      const rows = await app.readDb
        .select(fields)
        .from(patients)
        .where(and(eq(patients.selfRegistered, false), isNull(patients.deletedAt), eq(column, value)))
        .limit(1);
      return rows[0] ?? null;
    };

    let row = nic ? await find(patients.nic, nic) : null;
    if (!row && phone) row = await find(patients.phone, phone);
    if (!row) return { matched: false };

    return { matched: true, profile: row };
  });

  app.put("/", async (request) => {
    const accountId = request.patientActor!.patientAccountId;
    const body = parseOrThrowValidation(portalProfileSchema, request.body);
    const age = ageFromDob(body.dob);

    const updated = await app.db.transaction(async (tx) => {
      const rows = await tx
        .update(patientAccounts)
        .set({
          firstName: body.firstName,
          lastName: body.lastName,
          dob: body.dob,
          gender: body.gender,
          nic: body.nic ?? null,
          phone: body.phone ?? null,
          address: body.address ?? null,
          bloodGroup: body.bloodGroup ?? null,
          allergies: body.allergies ?? [],
          profileCompleted: true,
          updatedAt: new Date()
        })
        .where(eq(patientAccounts.id, accountId))
        .returning();

      // Keep already-linked self-registered clinic records in sync with edits.
      const links = await tx
        .select({ patientId: patientDoctorLinks.patientId, organizationId: patientDoctorLinks.organizationId })
        .from(patientDoctorLinks)
        .where(eq(patientDoctorLinks.patientAccountId, accountId));

      for (const link of links) {
        await tx
          .update(patients)
          .set({
            firstName: body.firstName,
            lastName: body.lastName,
            dob: body.dob,
            age,
            gender: body.gender,
            nic: body.nic ?? null,
            phone: body.phone ?? null,
            address: body.address ?? null,
            bloodGroup: body.bloodGroup ?? null,
            updatedAt: new Date()
          })
          .where(
            and(
              eq(patients.id, link.patientId),
              eq(patients.organizationId, link.organizationId),
              eq(patients.selfRegistered, true)
            )
          );
      }

      return rows[0];
    });

    return updated;
  });
};

export default portalProfileRoutes;

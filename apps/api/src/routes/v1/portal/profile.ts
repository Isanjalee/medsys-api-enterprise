import type { FastifyPluginAsync } from "fastify";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { encounters, patientAccounts, patientDoctorLinks, patients, userRoles, users } from "@medsys/db";
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
        .where(
          and(eq(patients.selfRegistered, false), isNull(patients.deletedAt), sql`upper(${column}) = upper(${value})`)
        )
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

    // Only touch location when a fresh capture is supplied (both coords) — a save without it
    // must not wipe a previously captured location.
    const hasLocation = body.latitude != null && body.longitude != null;
    const locationFields = hasLocation
      ? {
          latitude: String(body.latitude),
          longitude: String(body.longitude),
          locationAccuracyM: body.locationAccuracyM != null ? String(body.locationAccuracyM) : null,
          locationCapturedAt: new Date()
        }
      : {};

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
          // Only set district when supplied — a save without it must not wipe a chosen district.
          ...(body.district ? { district: body.district } : {}),
          allergies: body.allergies ?? [],
          ...locationFields,
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

      // Cross-account identity sync: adopt any existing clinic chart that matches this profile
      // on BOTH nic and dob (exact) — e.g. a chart another family member's account already
      // created for this same person, or a chart the clinic made from a walk-in — and inherit
      // its doctors. This account then sees its own history/reports/doctors without anyone
      // re-sharing. Requiring nic+dob (dob isn't public) stops a bare NIC from unlocking
      // someone else's records.
      const nic = body.nic?.trim() || null;
      if (nic) {
        const linkedPatientIds = new Set(links.map((l) => l.patientId));
        const matches = await tx
          .select({ id: patients.id, organizationId: patients.organizationId })
          .from(patients)
          .where(
            and(sql`upper(${patients.nic}) = upper(${nic})`, eq(patients.dob, body.dob), isNull(patients.deletedAt))
          );

        for (const chart of matches) {
          if (linkedPatientIds.has(chart.id)) continue;

          // Doctors this person is associated with: any existing portal link to the chart plus
          // the doctors who have actually treated them (encounters).
          const [linkDoctorRows, encDoctorRows] = await Promise.all([
            tx.select({ doctorUserId: patientDoctorLinks.doctorUserId }).from(patientDoctorLinks).where(eq(patientDoctorLinks.patientId, chart.id)),
            tx.select({ doctorId: encounters.doctorId }).from(encounters).where(eq(encounters.patientId, chart.id))
          ]);
          const candidateIds = new Set<number>();
          for (const r of linkDoctorRows) candidateIds.add(r.doctorUserId);
          for (const r of encDoctorRows) if (r.doctorId != null) candidateIds.add(r.doctorId);
          if (candidateIds.size === 0) continue;

          // Only link real, active doctors in that chart's clinic.
          const validDoctors = await tx
            .select({ id: users.id })
            .from(users)
            .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.role, "doctor")))
            .where(and(inArray(users.id, [...candidateIds]), eq(users.isActive, true), eq(users.organizationId, chart.organizationId)));

          for (const doctor of validDoctors) {
            const exists = await tx
              .select({ id: patientDoctorLinks.id })
              .from(patientDoctorLinks)
              .where(
                and(
                  eq(patientDoctorLinks.patientAccountId, accountId),
                  eq(patientDoctorLinks.doctorUserId, doctor.id),
                  eq(patientDoctorLinks.patientId, chart.id)
                )
              )
              .limit(1);
            if (exists.length === 0) {
              await tx.insert(patientDoctorLinks).values({
                patientAccountId: accountId,
                organizationId: chart.organizationId,
                patientId: chart.id,
                doctorUserId: doctor.id,
                memberId: null,
                status: "verified"
              });
            }
          }
          linkedPatientIds.add(chart.id);
        }
      }

      return rows[0];
    });

    return updated;
  });
};

export default portalProfileRoutes;

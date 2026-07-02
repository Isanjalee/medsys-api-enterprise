import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  families,
  familyMembers,
  organizations,
  patientAccountMembers,
  patientAccounts,
  patientDoctorLinks,
  patients,
  userRoles,
  users
} from "@medsys/db";
import { portalLinkDoctorSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../../lib/http-error.js";
import { buildDisplayName } from "../../../lib/names.js";

const ageFromDob = (dob: string): number => {
  const birth = new Date(`${dob}T00:00:00Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return Math.max(0, Math.min(age, 130));
};

const portalDoctorsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticatePatient);

  // System-wide doctor directory (across all clinics) for the patient to pick from.
  app.get("/directory", async () => {
    const rows = await app.readDb
      .selectDistinct({
        doctorUserId: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        organizationId: users.organizationId,
        clinicName: organizations.name,
        clinicSlug: organizations.slug
      })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(and(eq(userRoles.role, "doctor"), eq(users.isActive, true), eq(organizations.isActive, true)))
      .orderBy(asc(organizations.name), asc(users.firstName), asc(users.lastName));

    return rows.map((row) => ({
      doctorUserId: row.doctorUserId,
      name: buildDisplayName(row.firstName, row.lastName),
      organizationId: row.organizationId,
      clinicName: row.clinicName,
      clinicSlug: row.clinicSlug
    }));
  });

  // The patient's currently linked doctors.
  app.get("/", async (request) => {
    const rows = await app.readDb
      .select({
        linkId: patientDoctorLinks.id,
        doctorUserId: patientDoctorLinks.doctorUserId,
        organizationId: patientDoctorLinks.organizationId,
        patientId: patientDoctorLinks.patientId,
        status: patientDoctorLinks.status,
        firstName: users.firstName,
        lastName: users.lastName,
        clinicName: organizations.name
      })
      .from(patientDoctorLinks)
      .innerJoin(users, eq(users.id, patientDoctorLinks.doctorUserId))
      .innerJoin(organizations, eq(organizations.id, patientDoctorLinks.organizationId))
      .where(eq(patientDoctorLinks.patientAccountId, request.patientActor!.patientAccountId))
      .orderBy(asc(organizations.name));

    return rows.map((row) => ({
      linkId: row.linkId,
      doctorUserId: row.doctorUserId,
      organizationId: row.organizationId,
      patientId: row.patientId,
      status: row.status,
      doctorName: buildDisplayName(row.firstName, row.lastName),
      clinicName: row.clinicName
    }));
  });

  // Link a doctor: create (or reuse) a self-registered clinic record + the link.
  app.post("/link", async (request, reply) => {
    const accountId = request.patientActor!.patientAccountId;
    const { doctorUserId } = parseOrThrowValidation(portalLinkDoctorSchema, request.body);

    const accountRows = await app.db
      .select()
      .from(patientAccounts)
      .where(eq(patientAccounts.id, accountId))
      .limit(1);
    assertOrThrow(accountRows.length === 1, 404, "Account not found");
    const account = accountRows[0];
    assertOrThrow(
      account.profileCompleted && account.firstName && account.lastName && account.dob && account.gender,
      409,
      "Complete your profile before adding a doctor"
    );

    const doctorRows = await app.db
      .select({ id: users.id, organizationId: users.organizationId, isActive: users.isActive })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(userRoles.userId, doctorUserId), eq(userRoles.role, "doctor")))
      .limit(1);
    assertOrThrow(doctorRows.length === 1 && doctorRows[0].isActive, 404, "Doctor not found");
    const organizationId = doctorRows[0].organizationId;

    const existingLink = await app.db
      .select({ id: patientDoctorLinks.id })
      .from(patientDoctorLinks)
      .where(and(eq(patientDoctorLinks.patientAccountId, accountId), eq(patientDoctorLinks.doctorUserId, doctorUserId)))
      .limit(1);
    if (existingLink.length === 1) {
      return reply.code(200).send({ linkId: existingLink[0].id, alreadyLinked: true });
    }

    const patientCode = `SR-${accountId}-${doctorUserId}`.slice(0, 24);
    const age = ageFromDob(account.dob!);

    const nic = account.nic?.trim() || null;
    const phone = account.phone?.trim() || null;

    const result = await app.db.transaction(async (tx) => {
      // 1) Auto-merge: if this account's NIC (preferred) or phone matches an existing
      //    real clinic chart in this org, link straight to it so the patient sees their
      //    full existing history + documents. Product decision: auto-merge with no
      //    verification step (see below audit log — PHI-sensitive).
      let matchedPatientId: number | null = null;
      const findMatch = async (column: typeof patients.nic | typeof patients.phone, value: string) => {
        const rows = await tx
          .select({ id: patients.id })
          .from(patients)
          .where(
            and(
              eq(patients.organizationId, organizationId),
              eq(patients.selfRegistered, false),
              isNull(patients.deletedAt),
              eq(column, value)
            )
          )
          .limit(1);
        return rows.length === 1 ? rows[0].id : null;
      };
      if (nic) matchedPatientId = await findMatch(patients.nic, nic);
      if (matchedPatientId === null && phone) matchedPatientId = await findMatch(patients.phone, phone);

      let patientId: number;
      if (matchedPatientId !== null) {
        // Link to the existing chart; never overwrite the clinician-owned record.
        patientId = matchedPatientId;
      } else {
        // 2) No match — create (or reuse) a self-registered clinic record as before.
        const existingPatient = await tx
          .select({ id: patients.id })
          .from(patients)
          .where(and(eq(patients.organizationId, organizationId), eq(patients.patientCode, patientCode)))
          .limit(1);

        if (existingPatient.length === 1) {
          patientId = existingPatient[0].id;
          await tx
            .update(patients)
            .set({ isActive: true, deletedAt: null, updatedAt: new Date() })
            .where(eq(patients.id, patientId));
        } else {
          const inserted = await tx
            .insert(patients)
            .values({
              organizationId,
              patientCode,
              nic,
              firstName: account.firstName!,
              lastName: account.lastName!,
              dob: account.dob!,
              age,
              gender: account.gender as "male" | "female" | "other",
              phone,
              address: account.address ?? null,
              bloodGroup: account.bloodGroup ?? null,
              selfRegistered: true
            })
            .returning({ id: patients.id });
          patientId = inserted[0].id;
        }
      }

      const link = await tx
        .insert(patientDoctorLinks)
        .values({
          patientAccountId: accountId,
          organizationId,
          patientId,
          doctorUserId,
          // A match links to a real existing chart -> "verified"; otherwise self-registered.
          status: matchedPatientId !== null ? "verified" : "self_registered"
        })
        .returning();

      // --- Sync the portal family into this clinic: group the owner + members under one
      // clinic family so the doctor sees them together and portal history aggregates. ---
      const memberRows = await tx
        .select()
        .from(patientAccountMembers)
        .where(eq(patientAccountMembers.patientAccountId, accountId));

      const familyCode = `SRF-${accountId}`.slice(0, 30);
      const familyLabel = account.familyName?.trim() || `${account.lastName ?? "Patient"} Family`;
      let familyId: number;
      const existingFamily = await tx
        .select({ id: families.id })
        .from(families)
        .where(and(eq(families.organizationId, organizationId), eq(families.familyCode, familyCode)))
        .limit(1);
      if (existingFamily.length === 1) {
        familyId = existingFamily[0].id;
        await tx.update(families).set({ familyName: familyLabel, updatedAt: new Date() }).where(eq(families.id, familyId));
      } else {
        const fam = await tx
          .insert(families)
          .values({ organizationId, familyCode, familyName: familyLabel, assigned: true })
          .returning({ id: families.id });
        familyId = fam[0].id;
      }

      const linkToFamily = async (memberPatientId: number, relationship: string) => {
        await tx.update(patients).set({ familyId, updatedAt: new Date() }).where(eq(patients.id, memberPatientId));
        const existing = await tx
          .select({ id: familyMembers.id })
          .from(familyMembers)
          .where(and(eq(familyMembers.familyId, familyId), eq(familyMembers.patientId, memberPatientId)))
          .limit(1);
        if (existing.length === 0) {
          await tx.insert(familyMembers).values({ organizationId, familyId, patientId: memberPatientId, relationship });
        } else {
          await tx.update(familyMembers).set({ relationship }).where(eq(familyMembers.id, existing[0].id));
        }
      };

      await linkToFamily(patientId, "self");

      // Guardian NIC for minors without their own NIC: father -> mother -> account holder.
      const parentNic =
        memberRows.find((m) => m.relationship === "father" && m.nic)?.nic ??
        memberRows.find((m) => m.relationship === "mother" && m.nic)?.nic ??
        nic;

      for (const member of memberRows) {
        // A member can only become a clinic chart once they have a date of birth.
        if (!member.dob) continue;
        const memberOwnNic = member.nic?.trim() || null;
        // Skip a member who is the account holder themselves (same NIC) — already a chart.
        if (memberOwnNic && nic && memberOwnNic === nic) continue;
        const memberCode = `SRM-${accountId}-${member.id}`.slice(0, 30);
        const memberAge = ageFromDob(member.dob);
        const isMinor = memberAge < 18;
        const memberGender = (member.gender ?? "other") as "male" | "female" | "other";
        // Minors without their own NIC carry the guardian's NIC in the guardian field
        // (never in `nic` — that's unique per org and children share a parent's NIC).
        const memberValues = {
          firstName: member.firstName,
          lastName: member.lastName,
          dob: member.dob,
          age: memberAge,
          gender: memberGender,
          nic: memberOwnNic,
          guardianNic: isMinor && !memberOwnNic ? parentNic : null,
          guardianRelationship: isMinor && !memberOwnNic && parentNic ? "Guardian" : null,
          phone: member.phone ?? null,
          bloodGroup: member.bloodGroup ?? null
        };

        let memberPatientId: number;
        const existingMember = await tx
          .select({ id: patients.id })
          .from(patients)
          .where(and(eq(patients.organizationId, organizationId), eq(patients.patientCode, memberCode)))
          .limit(1);
        if (existingMember.length === 1) {
          memberPatientId = existingMember[0].id;
          await tx
            .update(patients)
            .set({ ...memberValues, isActive: true, deletedAt: null, updatedAt: new Date() })
            .where(eq(patients.id, memberPatientId));
        } else {
          const insertedMember = await tx
            .insert(patients)
            .values({ organizationId, patientCode: memberCode, selfRegistered: true, ...memberValues })
            .returning({ id: patients.id });
          memberPatientId = insertedMember[0].id;
        }
        await linkToFamily(memberPatientId, member.relationship);
      }

      return { linkId: link[0].id, patientId, merged: matchedPatientId !== null, familyId };
    });

    if (result.merged) {
      // PHI-safe audit trail (ids only; no NIC/phone values) of the auto-merge.
      request.log.info(
        { event: "portal.auto_merge", accountId, patientId: result.patientId, doctorUserId, organizationId },
        "Portal account auto-merged to an existing clinic chart by NIC/phone match"
      );
    }

    return reply.code(201).send(result);
  });

  app.delete("/:linkId", async (request) => {
    const accountId = request.patientActor!.patientAccountId;
    const linkId = Number((request.params as { linkId: string }).linkId);
    assertOrThrow(Number.isInteger(linkId), 400, "Invalid link id");
    await app.db
      .delete(patientDoctorLinks)
      .where(and(eq(patientDoctorLinks.id, linkId), eq(patientDoctorLinks.patientAccountId, accountId)));
    return { ok: true };
  });
};

export default portalDoctorsRoutes;

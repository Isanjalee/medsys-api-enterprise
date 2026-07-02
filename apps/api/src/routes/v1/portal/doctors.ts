import type { FastifyPluginAsync } from "fastify";
import { aliasedTable, and, asc, eq, isNull } from "drizzle-orm";
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

  // The patient's linked doctors, with which profile (member) each link is for + its tag.
  app.get("/", async (request) => {
    const member = aliasedTable(patientAccountMembers, "member");
    const rows = await app.readDb
      .select({
        linkId: patientDoctorLinks.id,
        doctorUserId: patientDoctorLinks.doctorUserId,
        organizationId: patientDoctorLinks.organizationId,
        patientId: patientDoctorLinks.patientId,
        status: patientDoctorLinks.status,
        label: patientDoctorLinks.label,
        memberId: patientDoctorLinks.memberId,
        memberFirst: member.firstName,
        memberLast: member.lastName,
        memberRelationship: member.relationship,
        firstName: users.firstName,
        lastName: users.lastName,
        clinicName: organizations.name
      })
      .from(patientDoctorLinks)
      .innerJoin(users, eq(users.id, patientDoctorLinks.doctorUserId))
      .innerJoin(organizations, eq(organizations.id, patientDoctorLinks.organizationId))
      .leftJoin(member, eq(member.id, patientDoctorLinks.memberId))
      .where(eq(patientDoctorLinks.patientAccountId, request.patientActor!.patientAccountId))
      .orderBy(asc(organizations.name));

    return rows.map((row) => ({
      linkId: row.linkId,
      doctorUserId: row.doctorUserId,
      organizationId: row.organizationId,
      patientId: row.patientId,
      status: row.status,
      label: row.label,
      memberId: row.memberId,
      // Whose profile this link is for ("You" for the account holder).
      profileName: row.memberId ? buildDisplayName(row.memberFirst ?? "", row.memberLast ?? "") : "You",
      profileRelationship: row.memberId ? row.memberRelationship : "self",
      doctorName: buildDisplayName(row.firstName, row.lastName),
      clinicName: row.clinicName
    }));
  });

  // Link a doctor to a specific profile (the account holder, or a family member), with an
  // optional custom tag. Each profile links its own doctors.
  app.post("/link", async (request, reply) => {
    const accountId = request.patientActor!.patientAccountId;
    const { doctorUserId, memberId, label } = parseOrThrowValidation(portalLinkDoctorSchema, request.body);

    const accountRows = await app.db.select().from(patientAccounts).where(eq(patientAccounts.id, accountId)).limit(1);
    assertOrThrow(accountRows.length === 1, 404, "Account not found");
    const account = accountRows[0];

    const doctorRows = await app.db
      .select({ id: users.id, organizationId: users.organizationId, isActive: users.isActive })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(userRoles.userId, doctorUserId), eq(userRoles.role, "doctor")))
      .limit(1);
    assertOrThrow(doctorRows.length === 1 && doctorRows[0].isActive, 404, "Doctor not found");
    const organizationId = doctorRows[0].organizationId;

    // Members loaded once — needed for the minor guardian-NIC fallback.
    const memberRows = await app.db
      .select()
      .from(patientAccountMembers)
      .where(eq(patientAccountMembers.patientAccountId, accountId));
    const ownerNic = account.nic?.trim() || null;
    const parentNic =
      memberRows.find((m) => m.relationship === "father" && m.nic)?.nic ??
      memberRows.find((m) => m.relationship === "mother" && m.nic)?.nic ??
      ownerNic;

    // Resolve the subject profile (account holder or a family member).
    type Subject = {
      code: string;
      relationship: string;
      firstName: string;
      lastName: string;
      dob: string;
      gender: "male" | "female" | "other";
      ownNic: string | null;
      guardianNic: string | null;
      guardianRelationship: string | null;
      phone: string | null;
      address: string | null;
      bloodGroup: string | null;
    };
    let subject: Subject;
    if (memberId != null) {
      const m = memberRows.find((row) => row.id === memberId);
      assertOrThrow(m, 404, "Family member not found");
      assertOrThrow(m!.dob, 409, "Add the member's date of birth before adding a doctor");
      const isMinor = ageFromDob(m!.dob!) < 18;
      const ownNic = m!.nic?.trim() || null;
      subject = {
        code: `SRM-${accountId}-${memberId}`.slice(0, 24),
        relationship: m!.relationship,
        firstName: m!.firstName,
        lastName: m!.lastName,
        dob: m!.dob!,
        gender: (m!.gender ?? "other") as "male" | "female" | "other",
        ownNic,
        guardianNic: isMinor && !ownNic ? parentNic : null,
        guardianRelationship: isMinor && !ownNic && parentNic ? "Guardian" : null,
        phone: m!.phone ?? null,
        address: null,
        bloodGroup: m!.bloodGroup ?? null
      };
    } else {
      assertOrThrow(
        account.profileCompleted && account.firstName && account.lastName && account.dob && account.gender,
        409,
        "Complete your profile before adding a doctor"
      );
      subject = {
        code: `SR-${accountId}-${doctorUserId}`.slice(0, 24),
        relationship: "self",
        firstName: account.firstName!,
        lastName: account.lastName!,
        dob: account.dob!,
        gender: account.gender as "male" | "female" | "other",
        ownNic: ownerNic,
        guardianNic: null,
        guardianRelationship: null,
        phone: account.phone?.trim() || null,
        address: account.address ?? null,
        bloodGroup: account.bloodGroup ?? null
      };
    }

    // Already linked (this profile to this doctor)? Update the tag if given.
    const existingLink = await app.db
      .select({ id: patientDoctorLinks.id })
      .from(patientDoctorLinks)
      .where(
        and(
          eq(patientDoctorLinks.patientAccountId, accountId),
          eq(patientDoctorLinks.doctorUserId, doctorUserId),
          memberId != null ? eq(patientDoctorLinks.memberId, memberId) : isNull(patientDoctorLinks.memberId)
        )
      )
      .limit(1);
    if (existingLink.length === 1) {
      if (label !== undefined) {
        await app.db
          .update(patientDoctorLinks)
          .set({ label: label || null, updatedAt: new Date() })
          .where(eq(patientDoctorLinks.id, existingLink[0].id));
      }
      return reply.code(200).send({ linkId: existingLink[0].id, alreadyLinked: true });
    }

    const age = ageFromDob(subject.dob);
    const familyCode = `SRF-${accountId}`.slice(0, 30);
    const familyLabel = account.familyName?.trim() || `${account.lastName ?? "Patient"} Family`;

    const result = await app.db.transaction(async (tx) => {
      // Resolve the clinic chart for this person. A NIC identifies one person per clinic, so
      // we reuse any existing chart with that NIC — whether it's a clinic-created record
      // (a true "verified" merge) or a self-registered one from another portal account
      // (the same person, e.g. a spouse who also has their own account). Reusing it keeps a
      // single shared chart per clinic and avoids the patients_org_nic_unique collision.
      let matchedPatientId: number | null = null;
      let matchedVerified = false;
      const findMatch = async (
        column: typeof patients.nic | typeof patients.phone,
        value: string,
        clinicChartsOnly: boolean
      ) => {
        const conditions = [
          eq(patients.organizationId, organizationId),
          isNull(patients.deletedAt),
          eq(column, value)
        ];
        if (clinicChartsOnly) conditions.push(eq(patients.selfRegistered, false));
        const rows = await tx.select({ id: patients.id }).from(patients).where(and(...conditions)).limit(1);
        return rows.length === 1 ? rows[0].id : null;
      };
      // Prefer a real clinic chart (counts as a verified merge)…
      if (subject.ownNic) matchedPatientId = await findMatch(patients.nic, subject.ownNic, true);
      if (matchedPatientId === null && memberId == null && subject.phone) {
        matchedPatientId = await findMatch(patients.phone, subject.phone, true);
      }
      if (matchedPatientId !== null) matchedVerified = true;
      // …otherwise fall back to any existing chart with this NIC (shared self-registered person).
      if (matchedPatientId === null && subject.ownNic) {
        matchedPatientId = await findMatch(patients.nic, subject.ownNic, false);
      }

      const values = {
        firstName: subject.firstName,
        lastName: subject.lastName,
        dob: subject.dob,
        age,
        gender: subject.gender,
        nic: subject.ownNic,
        guardianNic: subject.guardianNic,
        guardianRelationship: subject.guardianRelationship,
        phone: subject.phone,
        address: subject.address,
        bloodGroup: subject.bloodGroup
      };

      let patientId: number;
      if (matchedPatientId !== null) {
        patientId = matchedPatientId;
      } else {
        const existingPatient = await tx
          .select({ id: patients.id })
          .from(patients)
          .where(and(eq(patients.organizationId, organizationId), eq(patients.patientCode, subject.code)))
          .limit(1);
        if (existingPatient.length === 1) {
          patientId = existingPatient[0].id;
          await tx
            .update(patients)
            .set({ ...values, isActive: true, deletedAt: null, updatedAt: new Date() })
            .where(eq(patients.id, patientId));
        } else {
          const inserted = await tx
            .insert(patients)
            .values({ organizationId, patientCode: subject.code, selfRegistered: true, ...values })
            .returning({ id: patients.id });
          patientId = inserted[0].id;
        }
      }

      // Group this profile under the account's clinic family so the doctor sees the family.
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
      await tx.update(patients).set({ familyId, updatedAt: new Date() }).where(eq(patients.id, patientId));
      const existingFm = await tx
        .select({ id: familyMembers.id })
        .from(familyMembers)
        .where(and(eq(familyMembers.familyId, familyId), eq(familyMembers.patientId, patientId)))
        .limit(1);
      if (existingFm.length === 0) {
        await tx.insert(familyMembers).values({ organizationId, familyId, patientId, relationship: subject.relationship });
      } else {
        await tx.update(familyMembers).set({ relationship: subject.relationship }).where(eq(familyMembers.id, existingFm[0].id));
      }

      // Guard the (account, doctor, patient) uniqueness: if this same person is already linked
      // to this doctor under another profile in this account (e.g. added as both "you" and a
      // family member with the same NIC), reuse that link instead of hitting a 500.
      const dupLink = await tx
        .select({ id: patientDoctorLinks.id })
        .from(patientDoctorLinks)
        .where(
          and(
            eq(patientDoctorLinks.patientAccountId, accountId),
            eq(patientDoctorLinks.doctorUserId, doctorUserId),
            eq(patientDoctorLinks.patientId, patientId)
          )
        )
        .limit(1);
      if (dupLink.length === 1) {
        if (label !== undefined) {
          await tx.update(patientDoctorLinks).set({ label: label || null, updatedAt: new Date() }).where(eq(patientDoctorLinks.id, dupLink[0].id));
        }
        return { linkId: dupLink[0].id, patientId, merged: matchedVerified, alreadyLinked: true };
      }

      const link = await tx
        .insert(patientDoctorLinks)
        .values({
          patientAccountId: accountId,
          organizationId,
          patientId,
          doctorUserId,
          memberId: memberId ?? null,
          label: label || null,
          status: matchedVerified ? "verified" : "self_registered"
        })
        .returning();

      return { linkId: link[0].id, patientId, merged: matchedVerified };
    });

    if (result.merged) {
      request.log.info(
        { event: "portal.auto_merge", accountId, patientId: result.patientId, doctorUserId, organizationId, memberId: memberId ?? null },
        "Portal profile auto-merged to an existing clinic chart"
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

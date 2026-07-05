import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  patientAccountMembers,
  patientAccounts,
  patientDoctorLinks,
  patientHealthMetrics,
  patientHealthSurveys
} from "@medsys/db";
import { SRI_LANKA_DISTRICTS } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../../lib/http-error.js";

const RELATIONSHIPS = [
  "father",
  "mother",
  "son",
  "daughter",
  "brother",
  "sister",
  "grandfather",
  "grandmother",
  "husband",
  "wife",
  "guardian",
  "other"
] as const;

const memberSchema = z
  .object({
    firstName: z.string().trim().min(1).max(120),
    lastName: z.string().trim().min(1).max(120),
    relationship: z.enum(RELATIONSHIPS),
    dob: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
    gender: z.enum(["male", "female", "other"]).optional().nullable(),
    nic: z.string().trim().max(30).optional().nullable(),
    phone: z.string().trim().max(30).optional().nullable(),
    district: z.enum(SRI_LANKA_DISTRICTS).optional().nullable(),
    bloodGroup: z.string().trim().max(8).optional().nullable(),
    allergies: z
      .array(z.object({ name: z.string().trim().min(1), severity: z.enum(["low", "moderate", "high"]).optional() }))
      .optional()
  })
  .strict();

const familyNameSchema = z.object({ familyName: z.string().trim().max(120).nullable() }).strict();

const ageFromDob = (dob: string | null): number | null => {
  if (!dob) return null;
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return Math.max(0, Math.min(age, 130));
};

const portalFamilyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticatePatient);

  const loadMembers = async (accountId: number) => {
    const rows = await app.readDb
      .select()
      .from(patientAccountMembers)
      .where(eq(patientAccountMembers.patientAccountId, accountId))
      .orderBy(asc(patientAccountMembers.id));
    return rows;
  };

  // Resolve the guardian NIC used for under-18 members with no NIC of their own:
  // father's NIC preferred, then mother's, then the account holder's.
  const guardianNic = (
    members: Array<{ relationship: string; nic: string | null }>,
    ownerNic: string | null
  ): string | null => {
    const byRole = (role: string) => members.find((m) => m.relationship === role && m.nic)?.nic ?? null;
    return byRole("father") ?? byRole("mother") ?? ownerNic ?? null;
  };

  const serializeMember = (
    member: typeof patientAccountMembers.$inferSelect,
    parentNic: string | null
  ) => {
    const age = ageFromDob(member.dob);
    const isMinor = age !== null && age < 18;
    return {
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      relationship: member.relationship,
      dob: member.dob,
      age,
      gender: member.gender,
      nic: member.nic,
      // Effective NIC applies the guardian fallback for minors without their own NIC.
      effectiveNic: member.nic || (isMinor ? parentNic : null),
      phone: member.phone,
      district: member.district,
      bloodGroup: member.bloodGroup,
      allergies: member.allergies
    };
  };

  const account = async (accountId: number) => {
    const rows = await app.db.select().from(patientAccounts).where(eq(patientAccounts.id, accountId)).limit(1);
    assertOrThrow(rows.length === 1, 404, "Account not found");
    return rows[0];
  };

  // The whole family: name + members (with derived age + guardian-NIC fallback).
  app.get("/", async (request) => {
    const accountId = request.patientActor!.patientAccountId;
    const acc = await account(accountId);
    const members = await loadMembers(accountId);
    const parentNic = guardianNic(members, acc.nic ?? null);
    return {
      familyName: acc.familyName ?? null,
      members: members.map((m) => serializeMember(m, parentNic))
    };
  });

  app.put("/", async (request) => {
    const accountId = request.patientActor!.patientAccountId;
    const { familyName } = parseOrThrowValidation(familyNameSchema, request.body);
    await app.db
      .update(patientAccounts)
      .set({ familyName: familyName || null, updatedAt: new Date() })
      .where(eq(patientAccounts.id, accountId));
    return { familyName: familyName || null };
  });

  app.post("/members", async (request, reply) => {
    const accountId = request.patientActor!.patientAccountId;
    const body = parseOrThrowValidation(memberSchema, request.body);
    const inserted = await app.db
      .insert(patientAccountMembers)
      .values({
        patientAccountId: accountId,
        firstName: body.firstName,
        lastName: body.lastName,
        relationship: body.relationship,
        dob: body.dob ?? null,
        gender: body.gender ?? null,
        nic: body.nic?.trim() || null,
        phone: body.phone?.trim() || null,
        district: body.district ?? null,
        bloodGroup: body.bloodGroup?.trim() || null,
        allergies: body.allergies ?? []
      })
      .returning({ id: patientAccountMembers.id });
    return reply.code(201).send({ id: inserted[0].id });
  });

  app.patch("/members/:id", async (request) => {
    const accountId = request.patientActor!.patientAccountId;
    const id = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(id), 400, "Invalid member id");
    const body = parseOrThrowValidation(memberSchema, request.body);
    const updated = await app.db
      .update(patientAccountMembers)
      .set({
        firstName: body.firstName,
        lastName: body.lastName,
        relationship: body.relationship,
        dob: body.dob ?? null,
        gender: body.gender ?? null,
        nic: body.nic?.trim() || null,
        phone: body.phone?.trim() || null,
        district: body.district ?? null,
        bloodGroup: body.bloodGroup?.trim() || null,
        allergies: body.allergies ?? [],
        updatedAt: new Date()
      })
      .where(and(eq(patientAccountMembers.id, id), eq(patientAccountMembers.patientAccountId, accountId)))
      .returning({ id: patientAccountMembers.id });
    assertOrThrow(updated.length === 1, 404, "Member not found");
    return { ok: true };
  });

  app.delete("/members/:id", async (request) => {
    const accountId = request.patientActor!.patientAccountId;
    const id = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(id), 400, "Invalid member id");

    await app.db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: patientAccountMembers.id })
        .from(patientAccountMembers)
        .where(and(eq(patientAccountMembers.id, id), eq(patientAccountMembers.patientAccountId, accountId)))
        .limit(1);
      assertOrThrow(owned.length === 1, 404, "Member not found");

      // Remove the member's own dependent rows first (they FK-reference the member).
      await tx.delete(patientDoctorLinks).where(eq(patientDoctorLinks.memberId, id));
      await tx.delete(patientHealthMetrics).where(eq(patientHealthMetrics.memberId, id));
      await tx.delete(patientHealthSurveys).where(eq(patientHealthSurveys.memberId, id));
      await tx
        .delete(patientAccountMembers)
        .where(and(eq(patientAccountMembers.id, id), eq(patientAccountMembers.patientAccountId, accountId)));
    });

    return { ok: true };
  });
};

export default portalFamilyRoutes;

export { RELATIONSHIPS };

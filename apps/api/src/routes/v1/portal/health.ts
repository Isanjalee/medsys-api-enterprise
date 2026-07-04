import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { patientAccountMembers, patientHealthMetrics } from "@medsys/db";
import { portalHealthCreateSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../../lib/http-error.js";

// BMI = weight(kg) / height(m)^2, rounded to one decimal.
const bmiFrom = (weightKg: number, heightCm: number) => {
  const metres = heightCm / 100;
  return Math.round((weightKg / (metres * metres)) * 10) / 10;
};

const portalHealthRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticatePatient);

  // Measurements for one profile (self, or a family member via ?memberId), oldest → newest so
  // the client can draw the trend line directly.
  app.get("/", async (request) => {
    const accountId = request.patientActor!.patientAccountId;
    const raw = (request.query as { memberId?: string }).memberId;
    const memberId = raw === undefined || raw === "self" ? null : Number(raw);
    assertOrThrow(memberId === null || Number.isInteger(memberId), 400, "Invalid profile");

    const rows = await app.readDb
      .select({
        id: patientHealthMetrics.id,
        heightCm: patientHealthMetrics.heightCm,
        weightKg: patientHealthMetrics.weightKg,
        bmi: patientHealthMetrics.bmi,
        recordedAt: patientHealthMetrics.recordedAt,
        createdAt: patientHealthMetrics.createdAt
      })
      .from(patientHealthMetrics)
      .where(
        and(
          eq(patientHealthMetrics.patientAccountId, accountId),
          memberId === null ? isNull(patientHealthMetrics.memberId) : eq(patientHealthMetrics.memberId, memberId)
        )
      )
      .orderBy(asc(patientHealthMetrics.recordedAt), asc(patientHealthMetrics.id));

    return rows.map((r) => ({
      id: r.id,
      heightCm: Number(r.heightCm),
      weightKg: Number(r.weightKg),
      bmi: Number(r.bmi),
      recordedAt: r.recordedAt,
      createdAt: r.createdAt
    }));
  });

  // Record a new measurement; BMI is computed server-side.
  app.post("/", async (request, reply) => {
    const accountId = request.patientActor!.patientAccountId;
    const body = parseOrThrowValidation(portalHealthCreateSchema, request.body);
    const memberId = body.memberId ?? null;

    if (memberId !== null) {
      const owned = await app.readDb
        .select({ id: patientAccountMembers.id })
        .from(patientAccountMembers)
        .where(and(eq(patientAccountMembers.id, memberId), eq(patientAccountMembers.patientAccountId, accountId)))
        .limit(1);
      assertOrThrow(owned.length === 1, 404, "Profile not found");
    }

    const bmi = bmiFrom(body.weightKg, body.heightCm);
    const inserted = await app.db
      .insert(patientHealthMetrics)
      .values({
        patientAccountId: accountId,
        memberId,
        heightCm: String(body.heightCm),
        weightKg: String(body.weightKg),
        bmi: String(bmi)
      })
      .returning({ id: patientHealthMetrics.id, recordedAt: patientHealthMetrics.recordedAt });

    return reply.code(201).send({ id: inserted[0].id, bmi, recordedAt: inserted[0].recordedAt });
  });

  app.delete("/:id", async (request) => {
    const accountId = request.patientActor!.patientAccountId;
    const id = Number((request.params as { id: string }).id);
    assertOrThrow(Number.isInteger(id), 400, "Invalid id");
    await app.db
      .delete(patientHealthMetrics)
      .where(and(eq(patientHealthMetrics.id, id), eq(patientHealthMetrics.patientAccountId, accountId)));
    return { ok: true };
  });
};

export default portalHealthRoutes;

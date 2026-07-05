import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { patientAccountMembers, patientHealthSurveys } from "@medsys/db";
import { SURVEY_CONDITIONS, portalSurveyCreateSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../../lib/http-error.js";

const portalSurveyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticatePatient);

  // Submit one "Health Sri Lanka" survey for the active profile (self, or a family member).
  app.post("/", async (request, reply) => {
    const accountId = request.patientActor!.patientAccountId;
    const body = parseOrThrowValidation(portalSurveyCreateSchema, request.body);
    const memberId = body.memberId ?? null;

    if (memberId !== null) {
      const owned = await app.readDb
        .select({ id: patientAccountMembers.id })
        .from(patientAccountMembers)
        .where(and(eq(patientAccountMembers.id, memberId), eq(patientAccountMembers.patientAccountId, accountId)))
        .limit(1);
      assertOrThrow(owned.length === 1, 404, "Profile not found");
    }

    const inserted = await app.db
      .insert(patientHealthSurveys)
      .values({
        patientAccountId: accountId,
        memberId,
        district: body.district,
        hadCovid: body.hadCovid,
        hadDengue: body.hadDengue,
        conditions: body.conditions ?? [],
        latitude: body.latitude != null ? String(body.latitude) : null,
        longitude: body.longitude != null ? String(body.longitude) : null
      })
      .returning({ id: patientHealthSurveys.id, createdAt: patientHealthSurveys.createdAt });

    return reply.code(201).send({ id: inserted[0].id, createdAt: inserted[0].createdAt });
  });

  // The profile's most recent submission — lets the UI show "last answered" and pre-fill.
  app.get("/mine", async (request) => {
    const accountId = request.patientActor!.patientAccountId;
    const raw = (request.query as { memberId?: string }).memberId;
    const memberId = raw === undefined || raw === "self" ? null : Number(raw);
    assertOrThrow(memberId === null || Number.isInteger(memberId), 400, "Invalid profile");

    const rows = await app.readDb
      .select({
        id: patientHealthSurveys.id,
        district: patientHealthSurveys.district,
        hadCovid: patientHealthSurveys.hadCovid,
        hadDengue: patientHealthSurveys.hadDengue,
        conditions: patientHealthSurveys.conditions,
        createdAt: patientHealthSurveys.createdAt
      })
      .from(patientHealthSurveys)
      .where(
        and(
          eq(patientHealthSurveys.patientAccountId, accountId),
          memberId === null ? isNull(patientHealthSurveys.memberId) : eq(patientHealthSurveys.memberId, memberId)
        )
      )
      .orderBy(desc(patientHealthSurveys.id))
      .limit(1);

    return rows[0] ?? null;
  });

  // Universal district heat map: counts aggregated across ALL public submissions. Individual
  // locations are never exposed — only per-district totals per metric.
  app.get("/heatmap", async () => {
    // Newest first, so we can keep just the latest survey per profile (no double-counting when
    // someone re-answers).
    const rows = await app.readDb
      .select({
        patientAccountId: patientHealthSurveys.patientAccountId,
        memberId: patientHealthSurveys.memberId,
        district: patientHealthSurveys.district,
        hadCovid: patientHealthSurveys.hadCovid,
        hadDengue: patientHealthSurveys.hadDengue,
        conditions: patientHealthSurveys.conditions
      })
      .from(patientHealthSurveys)
      .orderBy(desc(patientHealthSurveys.id));

    const seen = new Set<string>();
    const map = new Map<string, Record<string, number>>();
    let counted = 0;
    for (const r of rows) {
      const profileKey = `${r.patientAccountId}:${r.memberId ?? "self"}`;
      if (seen.has(profileKey)) continue;
      seen.add(profileKey);
      counted += 1;
      let bucket = map.get(r.district);
      if (!bucket) {
        bucket = { total: 0, covid: 0, dengue: 0 };
        for (const c of SURVEY_CONDITIONS) bucket[c] = 0;
        map.set(r.district, bucket);
      }
      bucket.total += 1;
      if (r.hadCovid) bucket.covid += 1;
      if (r.hadDengue) bucket.dengue += 1;
      for (const c of r.conditions ?? []) if (c in bucket) bucket[c] += 1;
    }

    return {
      generatedAt: new Date().toISOString(),
      totalResponses: counted,
      metrics: ["covid", "dengue", ...SURVEY_CONDITIONS],
      districts: [...map.entries()].map(([district, counts]) => ({ district, ...counts }))
    };
  });
};

export default portalSurveyRoutes;

import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, ilike, isNull } from "drizzle-orm";
import { z } from "zod";
import { clinicalTerms, inventoryItems } from "@medsys/db";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";

const termTypeSchema = z.enum(["diagnosis", "test", "drug"]);
const suggestQuerySchema = z
  .object({
    type: termTypeSchema,
    q: z.string().max(255).optional().default(""),
    limit: z.coerce.number().int().min(1).max(50).optional().default(12)
  })
  .strict();
const listQuerySchema = z.object({ type: termTypeSchema.optional() }).strict();
const updateTermSchema = z.object({ name: z.string().min(1).max(255) }).strict();
const idParamSchema = z.object({ id: z.coerce.number().int().positive() }).strict();

const dictionaryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // Local autocomplete (replaces the external ICD-10/LOINC/drug suggestion APIs).
  app.get("/suggest", async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(suggestQuerySchema, request.query ?? {});
    const q = (query.q ?? "").trim();
    const limit = query.limit ?? 12;
    const like = `%${q}%`;

    const termRows = await app.readDb
      .select({ name: clinicalTerms.name, usageCount: clinicalTerms.usageCount })
      .from(clinicalTerms)
      .where(
        and(
          eq(clinicalTerms.organizationId, actor.organizationId),
          eq(clinicalTerms.doctorUserId, actor.userId),
          eq(clinicalTerms.termType, query.type),
          q ? ilike(clinicalTerms.name, like) : undefined
        )
      )
      .orderBy(desc(clinicalTerms.usageCount), clinicalTerms.name)
      .limit(limit);

    const names = new Map<string, number>();
    for (const row of termRows) {
      names.set(row.name, row.usageCount);
    }

    // Drug suggestions also include the clinic's inventory item names.
    if (query.type === "drug") {
      const inventoryRows = await app.readDb
        .select({ name: inventoryItems.name })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.organizationId, actor.organizationId),
            isNull(inventoryItems.deletedAt),
            q ? ilike(inventoryItems.name, like) : undefined
          )
        )
        .limit(limit);
      for (const row of inventoryRows) {
        if (!names.has(row.name)) {
          names.set(row.name, 0);
        }
      }
    }

    const suggestions = Array.from(names.keys())
      .slice(0, limit)
      .map((name) => ({ name }));
    return { suggestions };
  });

  // Doctor's saved dictionary, for the management page.
  app.get("/terms", async (request) => {
    const actor = request.actor!;
    const query = parseOrThrowValidation(listQuerySchema, request.query ?? {});
    const rows = await app.readDb
      .select({
        id: clinicalTerms.id,
        termType: clinicalTerms.termType,
        name: clinicalTerms.name,
        usageCount: clinicalTerms.usageCount,
        lastUsedAt: clinicalTerms.lastUsedAt
      })
      .from(clinicalTerms)
      .where(
        and(
          eq(clinicalTerms.organizationId, actor.organizationId),
          eq(clinicalTerms.doctorUserId, actor.userId),
          query.type ? eq(clinicalTerms.termType, query.type) : undefined
        )
      )
      .orderBy(desc(clinicalTerms.usageCount), clinicalTerms.name);
    return {
      terms: rows.map((row) => ({
        id: row.id,
        term_type: row.termType,
        name: row.name,
        usage_count: row.usageCount,
        last_used_at: row.lastUsedAt
      }))
    };
  });

  app.patch("/terms/:id", async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const { name } = parseOrThrowValidation(updateTermSchema, request.body);

    const existing = await app.readDb
      .select({ id: clinicalTerms.id, termType: clinicalTerms.termType })
      .from(clinicalTerms)
      .where(
        and(
          eq(clinicalTerms.id, id),
          eq(clinicalTerms.organizationId, actor.organizationId),
          eq(clinicalTerms.doctorUserId, actor.userId)
        )
      )
      .limit(1);
    assertOrThrow(existing.length === 1, 404, "Term not found.");

    const duplicate = await app.readDb
      .select({ id: clinicalTerms.id })
      .from(clinicalTerms)
      .where(
        and(
          eq(clinicalTerms.organizationId, actor.organizationId),
          eq(clinicalTerms.doctorUserId, actor.userId),
          eq(clinicalTerms.termType, existing[0].termType),
          eq(clinicalTerms.name, name.trim())
        )
      )
      .limit(1);
    assertOrThrow(
      duplicate.length === 0 || duplicate[0].id === id,
      409,
      "You already have a term with that name."
    );

    const updated = await app.db
      .update(clinicalTerms)
      .set({ name: name.trim(), updatedAt: new Date() })
      .where(eq(clinicalTerms.id, id))
      .returning({ id: clinicalTerms.id, termType: clinicalTerms.termType, name: clinicalTerms.name });
    return {
      term: { id: updated[0].id, term_type: updated[0].termType, name: updated[0].name }
    };
  });

  app.delete("/terms/:id", async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const deleted = await app.db
      .delete(clinicalTerms)
      .where(
        and(
          eq(clinicalTerms.id, id),
          eq(clinicalTerms.organizationId, actor.organizationId),
          eq(clinicalTerms.doctorUserId, actor.userId)
        )
      )
      .returning({ id: clinicalTerms.id });
    assertOrThrow(deleted.length === 1, 404, "Term not found.");
    return { ok: true };
  });
};

export default dictionaryRoutes;

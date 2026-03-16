import type { FastifyPluginAsync } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { families, familyMembers, patients } from "@medsys/db";
import { createFamilyMemberSchema, createFamilySchema, idParamSchema } from "@medsys/validation";
import { assertOrThrow, parseOrThrowValidation } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const createFamilyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["familyName"],
  properties: {
    familyCode: { type: "string", maxLength: 30 },
    familyName: { type: "string", minLength: 1, maxLength: 120 },
    assigned: { type: "boolean" }
  },
  example: {
    familyCode: "FAM-1001",
    familyName: "Silva Family",
    assigned: false
  }
} as const;

const familiesRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Families", "FamiliesController", {
    "GET /": {
      operationId: "FamiliesController_findAll",
      summary: "List families"
    },
    "POST /": {
      operationId: "FamiliesController_create",
      summary: "Create family",
      bodySchema: createFamilyBodySchema,
      bodyExample: {
        familyCode: "FAM-1001",
        familyName: "Silva Family",
        assigned: false
      }
    },
    "GET /:id": {
      operationId: "FamiliesController_findOne",
      summary: "Get family with members"
    },
    "POST /:id/members": {
      operationId: "FamiliesController_addMember",
      summary: "Add patient to family",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["patientId"],
        properties: {
          patientId: { type: "integer", minimum: 1 },
          relationship: { type: "string", maxLength: 40 }
        }
      },
      bodyExample: {
        patientId: 1,
        relationship: "father"
      }
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get("/", { preHandler: app.authorizePermissions(["family.read"]) }, async (request) => {
    const actor = request.actor!;
    return app.readDb
      .select()
      .from(families)
      .where(and(eq(families.organizationId, actor.organizationId), isNull(families.deletedAt)));
  });

  app.post(
    "/",
    {
      preHandler: app.authorizePermissions(["family.write"]),
      schema: {
        tags: ["Families"],
        operationId: "FamiliesController_create",
        summary: "Create family",
        body: createFamilyBodySchema
      }
    },
    async (request, reply) => {
      const actor = request.actor!;
      const payload = parseOrThrowValidation(createFamilySchema.strict(), request.body);
      const familyCode =
      payload.familyCode ?? `FAM-${new Date().getTime().toString(36).slice(-8).toUpperCase()}`;
    const inserted = await app.db
      .insert(families)
      .values({
        organizationId: actor.organizationId,
        familyCode,
        familyName: payload.familyName,
        assigned: payload.assigned ?? false
      })
      .returning();
    await writeAuditLog(request, {
      entityType: "family",
      action: "create",
      entityId: inserted[0].id
    });
      return reply.code(201).send(inserted[0]);
    }
  );

  app.get("/:id", { preHandler: app.authorizePermissions(["family.read"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const found = await app.readDb
      .select()
      .from(families)
      .where(and(eq(families.id, id), eq(families.organizationId, actor.organizationId)))
      .limit(1);
    assertOrThrow(found.length === 1, 404, "Family not found");

    const members = await app.readDb
      .select({
        membershipId: familyMembers.id,
        patientId: patients.id,
        patientCode: patients.patientCode,
        firstName: patients.firstName,
        lastName: patients.lastName,
        nic: patients.nic,
        relationship: familyMembers.relationship
      })
      .from(familyMembers)
      .innerJoin(patients, eq(familyMembers.patientId, patients.id))
      .where(
        and(
          eq(familyMembers.familyId, id),
          eq(familyMembers.organizationId, actor.organizationId),
          isNull(patients.deletedAt)
        )
      );

    return { family: found[0], members };
  });

  app.post("/:id/members", { preHandler: app.authorizePermissions(["family.write"]) }, async (request, reply) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const body = parseOrThrowValidation(createFamilyMemberSchema, request.body);

    const inserted = await app.db
      .insert(familyMembers)
      .values({
        organizationId: actor.organizationId,
        familyId: id,
        patientId: body.patientId,
        relationship: body.relationship ?? null
      })
      .returning();

    await app.db
      .update(patients)
      .set({ familyId: id, updatedAt: new Date() })
      .where(and(eq(patients.id, body.patientId), eq(patients.organizationId, actor.organizationId)));

    await writeAuditLog(request, {
      entityType: "family_member",
      action: "create",
      entityId: inserted[0].id
    });

    return reply.code(201).send(inserted[0]);
  });
};

export default familiesRoutes;

import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  patientAllergies,
  patientConditions,
  patientTimelineEvents,
  patientVitals,
  patients
} from "@medsys/db";
import {
  createPatientSchema,
  createVitalSchema,
  idParamSchema,
  updatePatientSchema
} from "@medsys/validation";
import { calculateAgeFromDob } from "../../lib/date.js";
import { assertOrThrow } from "../../lib/http-error.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const patientRoutes: FastifyPluginAsync = async (app) => {
  const tag = "Patients";
  applyRouteDocs(app, tag, "PatientsController", {
    "GET /": {
      operationId: "PatientsController_findAll",
      summary: "List patients"
    },
    "POST /": {
      operationId: "PatientsController_create",
      summary: "Create patient",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["firstName", "lastName", "gender"],
        properties: {
          nic: { type: "string", nullable: true },
          firstName: { type: "string", minLength: 1, maxLength: 80 },
          lastName: { type: "string", minLength: 1, maxLength: 80 },
          dob: { type: "string", format: "date", nullable: true },
          age: { type: "integer", minimum: 0, maximum: 130, nullable: true },
          gender: { type: "string", enum: ["male", "female", "other"] },
          phone: { type: "string", nullable: true },
          address: { type: "string", nullable: true },
          bloodGroup: { type: "string", nullable: true },
          familyId: { type: "integer", minimum: 1, nullable: true }
        }
      },
      bodyExample: {
        nic: "199912345678",
        firstName: "Kamal",
        lastName: "Silva",
        dob: "1999-06-10",
        gender: "male",
        phone: "+94770000001",
        address: "Colombo",
        bloodGroup: "B+",
        familyId: 1
      }
    },
    "GET /:id": {
      operationId: "PatientsController_findOne",
      summary: "Get patient by id"
    },
    "PATCH /:id": {
      operationId: "PatientsController_update",
      summary: "Update patient",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          nic: { type: "string", nullable: true },
          firstName: { type: "string", minLength: 1, maxLength: 80 },
          lastName: { type: "string", minLength: 1, maxLength: 80 },
          dob: { type: "string", format: "date", nullable: true },
          age: { type: "integer", minimum: 0, maximum: 130, nullable: true },
          gender: { type: "string", enum: ["male", "female", "other"] },
          phone: { type: "string", nullable: true },
          address: { type: "string", nullable: true },
          bloodGroup: { type: "string", nullable: true },
          familyId: { type: "integer", minimum: 1, nullable: true }
        }
      },
      bodyExample: {
        phone: "+94770000002",
        address: "No.10, Main Street, Colombo"
      }
    },
    "GET /:id/profile": {
      operationId: "PatientsController_profile",
      summary: "Get patient full profile"
    },
    "GET /:id/family": {
      operationId: "PatientsController_family",
      summary: "Get patient's family"
    },
    "GET /:id/allergies": {
      operationId: "PatientsController_listAllergies",
      summary: "List patient allergies"
    },
    "POST /:id/allergies": {
      operationId: "PatientsController_addAllergy",
      summary: "Add patient allergy",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["allergyName"],
        properties: {
          allergyName: { type: "string", minLength: 1, maxLength: 120 },
          severity: { type: "string", enum: ["low", "moderate", "high"], nullable: true },
          isActive: { type: "boolean" }
        }
      },
      bodyExample: {
        allergyName: "Penicillin",
        severity: "high",
        isActive: true
      }
    },
    "GET /:id/conditions": {
      operationId: "PatientsController_listConditions",
      summary: "List patient conditions"
    },
    "POST /:id/conditions": {
      operationId: "PatientsController_addCondition",
      summary: "Add patient condition",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["conditionName"],
        properties: {
          conditionName: { type: "string", minLength: 1, maxLength: 180 },
          icd10Code: { type: "string", maxLength: 16, nullable: true },
          status: { type: "string" }
        }
      },
      bodyExample: {
        conditionName: "Type 2 Diabetes",
        icd10Code: "E11.9",
        status: "active"
      }
    },
    "GET /:id/vitals": {
      operationId: "PatientsController_listVitals",
      summary: "List patient vitals"
    },
    "POST /:id/vitals": {
      operationId: "PatientsController_addVital",
      summary: "Add patient vital record",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["recordedAt"],
        properties: {
          encounterId: { type: "integer", minimum: 1, nullable: true },
          bpSystolic: { type: "integer", minimum: 30, maximum: 300, nullable: true },
          bpDiastolic: { type: "integer", minimum: 20, maximum: 200, nullable: true },
          heartRate: { type: "integer", minimum: 20, maximum: 300, nullable: true },
          temperatureC: { type: "number", minimum: 25, maximum: 45, nullable: true },
          spo2: { type: "integer", minimum: 0, maximum: 100, nullable: true },
          recordedAt: { type: "string", format: "date-time" }
        }
      },
      bodyExample: {
        encounterId: 7,
        bpSystolic: 120,
        bpDiastolic: 80,
        heartRate: 78,
        temperatureC: 37.2,
        spo2: 98,
        recordedAt: "2026-03-05T10:15:00Z"
      }
    },
    "GET /:id/timeline": {
      operationId: "PatientsController_listTimeline",
      summary: "List patient timeline events"
    },
    "POST /:id/timeline": {
      operationId: "PatientsController_addTimelineEvent",
      summary: "Add patient timeline event",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["eventDate", "title"],
        properties: {
          encounterId: { type: "integer", minimum: 1, nullable: true },
          eventDate: { type: "string", format: "date" },
          title: { type: "string", minLength: 1, maxLength: 160 },
          description: { type: "string", nullable: true },
          eventKind: { type: "string", nullable: true },
          tags: { type: "array", items: { type: "string" }, nullable: true },
          value: { type: "string", nullable: true }
        }
      },
      bodyExample: {
        encounterId: 7,
        eventDate: "2026-03-05",
        title: "Follow-up suggested",
        description: "Review after one week",
        eventKind: "checkup",
        tags: ["followup", "doctor-note"],
        value: "review-7-days"
      }
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.get(
    "/",
    {
      preHandler: app.authorize(["owner", "doctor", "assistant"]),
      schema: {
        tags: [tag],
        operationId: "PatientsController_findAll",
        summary: "List patients"
      }
    },
    async (request) => {
      const actor = request.actor!;
      const rows = await app.readDb
        .select()
        .from(patients)
        .where(and(eq(patients.organizationId, actor.organizationId), isNull(patients.deletedAt)))
        .orderBy(desc(patients.createdAt))
        .limit(200);

      await writeAuditLog(request, { entityType: "patient", action: "list" });
      return rows;
    }
  );

  app.post(
    "/",
    {
      preHandler: app.authorize(["owner", "assistant"]),
      schema: {
        tags: [tag],
        operationId: "PatientsController_create",
        summary: "Create patient"
      }
    },
    async (request, reply) => {
      const actor = request.actor!;
      const payload = createPatientSchema.parse(request.body);
      const dob = payload.dob ? new Date(payload.dob) : null;
      const dobAge = dob ? calculateAgeFromDob(dob) : null;
      const calculatedAge = dobAge ?? payload.age ?? null;

      if (dobAge != null && payload.age != null) {
        assertOrThrow(Math.abs(dobAge - payload.age) <= 1, 400, "Age does not match DOB");
      }

      const inserted = await app.db
        .insert(patients)
        .values({
          organizationId: actor.organizationId,
          nic: payload.nic ?? null,
          firstName: payload.firstName,
          lastName: payload.lastName,
          fullName: `${payload.firstName} ${payload.lastName}`,
          dob: payload.dob ?? null,
          age: calculatedAge,
          gender: payload.gender,
          phone: payload.phone ?? null,
          address: payload.address ?? null,
          bloodGroup: payload.bloodGroup ?? null,
          familyId: payload.familyId ?? null
        })
        .returning();

      await writeAuditLog(request, {
        entityType: "patient",
        action: "create",
        entityId: inserted[0].id
      })
      return reply.code(201).send(inserted[0]);
    }
  );

  app.get(
    "/:id",
    {
      preHandler: app.authorize(["owner", "doctor", "assistant"]),
      schema: {
        tags: [tag],
        operationId: "PatientsController_findOne",
        summary: "Get patient by id"
      }
    },
    async (request) => {
      const actor = request.actor!;
      const { id } = idParamSchema.parse(request.params);
      const rows = await app.readDb
        .select()
        .from(patients)
        .where(
          and(
            eq(patients.id, id),
            eq(patients.organizationId, actor.organizationId),
            isNull(patients.deletedAt)
          )
        )
        .limit(1);

      assertOrThrow(rows.length === 1, 404, "Patient not found");
      await writeAuditLog(request, { entityType: "patient", entityId: id, action: "read" });
      return rows[0];
    }
  );

  app.patch(
    "/:id",
    {
      preHandler: app.authorize(["owner", "assistant"]),
      schema: {
        tags: [tag],
        operationId: "PatientsController_update",
        summary: "Update patient"
      }
    },
    async (request) => {
      const actor = request.actor!;
      const { id } = idParamSchema.parse(request.params);
      const payload = updatePatientSchema.parse(request.body);

    const updateData: Record<string, unknown> = {
      updatedAt: new Date()
    };

    if (payload.firstName !== undefined) {
      updateData.firstName = payload.firstName;
    }
    if (payload.lastName !== undefined) {
      updateData.lastName = payload.lastName;
    }
    if (payload.firstName || payload.lastName) {
      const existing = await app.db
        .select({ firstName: patients.firstName, lastName: patients.lastName })
        .from(patients)
        .where(and(eq(patients.id, id), eq(patients.organizationId, actor.organizationId)))
        .limit(1);
      assertOrThrow(existing.length === 1, 404, "Patient not found");
      const nextFirst = payload.firstName ?? existing[0].firstName;
      const nextLast = payload.lastName ?? existing[0].lastName;
      updateData.fullName = `${nextFirst} ${nextLast}`;
    }

    if (payload.dob !== undefined) {
      updateData.dob = payload.dob;
      if (payload.dob) {
        updateData.age = calculateAgeFromDob(new Date(payload.dob));
      }
    }

    if (payload.age !== undefined) {
      updateData.age = payload.age;
    }
    if (payload.nic !== undefined) {
      updateData.nic = payload.nic;
    }
    if (payload.gender !== undefined) {
      updateData.gender = payload.gender;
    }
    if (payload.phone !== undefined) {
      updateData.phone = payload.phone;
    }
    if (payload.address !== undefined) {
      updateData.address = payload.address;
    }
    if (payload.bloodGroup !== undefined) {
      updateData.bloodGroup = payload.bloodGroup;
    }
    if (payload.familyId !== undefined) {
      updateData.familyId = payload.familyId;
    }

      const updated = await app.db
        .update(patients)
        .set(updateData)
        .where(and(eq(patients.id, id), eq(patients.organizationId, actor.organizationId)))
        .returning();

      assertOrThrow(updated.length === 1, 404, "Patient not found");

      await writeAuditLog(request, {
        entityType: "patient",
        action: "update",
        entityId: id
      });
      return updated[0];
    }
  );

  app.get(
    "/:id/profile",
    { preHandler: app.authorize(["owner", "doctor", "assistant"]) },
    async (request) => {
      const actor = request.actor!;
      const { id } = idParamSchema.parse(request.params);

      const [patient] = await app.readDb
        .select()
        .from(patients)
        .where(
          and(
            eq(patients.id, id),
            eq(patients.organizationId, actor.organizationId),
            isNull(patients.deletedAt)
          )
        )
        .limit(1);
      assertOrThrow(patient, 404, "Patient not found");

      const [allergies, conditions, vitals, timeline] = await Promise.all([
        app.readDb
          .select()
          .from(patientAllergies)
          .where(
            and(
              eq(patientAllergies.patientId, id),
              eq(patientAllergies.organizationId, actor.organizationId),
              isNull(patientAllergies.deletedAt)
            )
          ),
        app.readDb
          .select()
          .from(patientConditions)
          .where(
            and(
              eq(patientConditions.patientId, id),
              eq(patientConditions.organizationId, actor.organizationId),
              isNull(patientConditions.deletedAt)
            )
          ),
        app.readDb
          .select()
          .from(patientVitals)
          .where(
            and(
              eq(patientVitals.patientId, id),
              eq(patientVitals.organizationId, actor.organizationId),
              isNull(patientVitals.deletedAt)
            )
          )
          .orderBy(desc(patientVitals.recordedAt))
          .limit(20),
        app.readDb
          .select()
          .from(patientTimelineEvents)
          .where(
            and(
              eq(patientTimelineEvents.patientId, id),
              eq(patientTimelineEvents.organizationId, actor.organizationId),
              isNull(patientTimelineEvents.deletedAt)
            )
          )
          .orderBy(desc(patientTimelineEvents.eventDate))
          .limit(100)
      ]);

      return { patient, allergies, conditions, vitals, timeline };
    }
  );

  app.get("/:id/family", { preHandler: app.authorize(["owner", "doctor", "assistant"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = idParamSchema.parse(request.params);

    const row = await app.readDb
      .select({ familyId: patients.familyId })
      .from(patients)
      .where(and(eq(patients.id, id), eq(patients.organizationId, actor.organizationId)))
      .limit(1);
    assertOrThrow(row.length === 1, 404, "Patient not found");

    return { familyId: row[0].familyId };
  });

  app.get(
    "/:id/allergies",
    { preHandler: app.authorize(["owner", "doctor", "assistant"]) },
    async (request) => {
      const actor = request.actor!;
      const { id } = idParamSchema.parse(request.params);
      return app.readDb
        .select()
        .from(patientAllergies)
        .where(
          and(
            eq(patientAllergies.patientId, id),
            eq(patientAllergies.organizationId, actor.organizationId),
            isNull(patientAllergies.deletedAt)
          )
        );
    }
  );

  app.get(
    "/:id/conditions",
    { preHandler: app.authorize(["owner", "doctor", "assistant"]) },
    async (request) => {
      const actor = request.actor!;
      const { id } = idParamSchema.parse(request.params);
      return app.readDb
        .select()
        .from(patientConditions)
        .where(
          and(
            eq(patientConditions.patientId, id),
            eq(patientConditions.organizationId, actor.organizationId),
            isNull(patientConditions.deletedAt)
          )
        );
    }
  );

  app.post("/:id/conditions", { preHandler: app.authorize(["owner", "doctor"]) }, async (request, reply) => {
    const actor = request.actor!;
    const { id } = idParamSchema.parse(request.params);
    const body = request.body as {
      conditionName: string;
      icd10Code?: string | null;
      status?: string;
    };
    assertOrThrow(Boolean(body?.conditionName), 400, "conditionName is required");

    const inserted = await app.db
      .insert(patientConditions)
      .values({
        organizationId: actor.organizationId,
        patientId: id,
        conditionName: body.conditionName,
        icd10Code: body.icd10Code ?? null,
        status: body.status ?? "active"
      })
      .returning();
    await writeAuditLog(request, {
      entityType: "patient_condition",
      action: "create",
      entityId: inserted[0].id
    });
    return reply.code(201).send(inserted[0]);
  });

  app.post("/:id/allergies", { preHandler: app.authorize(["owner", "doctor"]) }, async (request, reply) => {
    const actor = request.actor!;
    const { id } = idParamSchema.parse(request.params);
    const body = request.body as {
      allergyName: string;
      severity?: "low" | "moderate" | "high" | null;
      isActive?: boolean;
    };
    assertOrThrow(Boolean(body?.allergyName), 400, "allergyName is required");
    const inserted = await app.db
      .insert(patientAllergies)
      .values({
        organizationId: actor.organizationId,
        patientId: id,
        allergyName: body.allergyName,
        severity: body.severity ?? null,
        isActive: body.isActive ?? true
      })
      .returning();
    await writeAuditLog(request, {
      entityType: "patient_allergy",
      action: "create",
      entityId: inserted[0].id
    });
    return reply.code(201).send(inserted[0]);
  });

  app.get("/:id/vitals", { preHandler: app.authorize(["owner", "doctor", "assistant"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = idParamSchema.parse(request.params);
    return app.readDb
      .select()
      .from(patientVitals)
      .where(
        and(
          eq(patientVitals.patientId, id),
          eq(patientVitals.organizationId, actor.organizationId),
          isNull(patientVitals.deletedAt)
        )
      )
      .orderBy(desc(patientVitals.recordedAt));
  });

  app.post("/:id/vitals", { preHandler: app.authorize(["doctor", "assistant"]) }, async (request, reply) => {
    const actor = request.actor!;
    const params = idParamSchema.parse(request.params);
    const payload = createVitalSchema.parse({
      ...(request.body as Record<string, unknown>),
      patientId: params.id
    });

    const inserted = await app.db
      .insert(patientVitals)
      .values({
        organizationId: actor.organizationId,
        patientId: payload.patientId,
        encounterId: payload.encounterId ?? null,
        bpSystolic: payload.bpSystolic ?? null,
        bpDiastolic: payload.bpDiastolic ?? null,
        heartRate: payload.heartRate ?? null,
        temperatureC: payload.temperatureC?.toString() ?? null,
        spo2: payload.spo2 ?? null,
        recordedAt: new Date(payload.recordedAt)
      })
      .returning();
    await writeAuditLog(request, {
      entityType: "patient_vitals",
      action: "create",
      entityId: inserted[0].id
    });
    return reply.code(201).send(inserted[0]);
  });

  app.get("/:id/timeline", { preHandler: app.authorize(["owner", "doctor", "assistant"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = idParamSchema.parse(request.params);
    return app.readDb
      .select()
      .from(patientTimelineEvents)
      .where(
        and(
          eq(patientTimelineEvents.patientId, id),
          eq(patientTimelineEvents.organizationId, actor.organizationId),
          isNull(patientTimelineEvents.deletedAt)
        )
      )
      .orderBy(desc(patientTimelineEvents.eventDate));
  });

  app.post("/:id/timeline", { preHandler: app.authorize(["doctor", "assistant"]) }, async (request, reply) => {
    const actor = request.actor!;
    const { id } = idParamSchema.parse(request.params);
    const body = request.body as {
      encounterId?: number | null;
      eventDate: string;
      title: string;
      description?: string | null;
      eventKind?: string | null;
      tags?: string[] | null;
      value?: string | null;
    };
    assertOrThrow(Boolean(body?.eventDate), 400, "eventDate is required");
    assertOrThrow(Boolean(body?.title), 400, "title is required");

    const inserted = await app.db
      .insert(patientTimelineEvents)
      .values({
        organizationId: actor.organizationId,
        patientId: id,
        encounterId: body.encounterId ?? null,
        eventDate: body.eventDate,
        title: body.title,
        description: body.description ?? null,
        eventKind: body.eventKind ?? null,
        tags: body.tags ?? null,
        value: body.value ?? null
      })
      .returning();
    await writeAuditLog(request, {
      entityType: "patient_timeline",
      action: "create",
      entityId: inserted[0].id
    });
    return reply.code(201).send(inserted[0]);
  });
};

export default patientRoutes;

import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  patientAllergies,
  patientConditions,
  patientHistoryEntries,
  patientTimelineEvents,
  patientVitals,
  patients,
  users
} from "@medsys/db";
import {
  createPatientAllergySchema,
  createPatientConditionSchema,
  createPatientHistorySchema,
  createPatientFrontendSchema,
  createPatientSchema,
  createPatientTimelineEventSchema,
  createVitalSchema,
  idParamSchema,
  updatePatientFrontendSchema,
  updatePatientSchema
} from "@medsys/validation";
import { serializePatientHistoryEntry, serializePatientSummary } from "../../lib/api-serializers.js";
import { calculateAgeFromDob } from "../../lib/date.js";
import { assertOrThrow, parseOrThrowValidation, validationError } from "../../lib/http-error.js";
import { splitFullName } from "../../lib/names.js";
import { writeAuditLog } from "../../lib/audit.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const hasAnyKey = (value: unknown, keys: string[]): boolean =>
  Boolean(
    value &&
      typeof value === "object" &&
      keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))
  );

const assertFrontendNameHasFirstAndLast = (fullName: string): { firstName: string; lastName: string } => {
  const nameParts = splitFullName(fullName);
  if (!nameParts.firstName.trim() || !nameParts.lastName.trim()) {
    throw validationError([
      {
        field: "name",
        message: "First name and last name are required."
      }
    ]);
  }
  return {
    firstName: nameParts.firstName,
    lastName: nameParts.lastName
  };
};

const calculateValidatedAge = (dob: string, age?: number): number => {
  const derivedAge = calculateAgeFromDob(new Date(dob));
  if (age !== undefined && Math.abs(derivedAge - age) > 1) {
    throw validationError([
      {
        field: "age",
        message: "Age does not match DOB."
      }
    ]);
  }
  return derivedAge;
};

const patientProfileCacheKey = (organizationId: string, patientId: number): string =>
  `${organizationId}:${patientId}`;

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
        required: ["firstName", "lastName", "dob", "gender"],
        properties: {
          nic: { type: "string", nullable: true },
          firstName: { type: "string", minLength: 1, maxLength: 80 },
          lastName: { type: "string", minLength: 1, maxLength: 80 },
          dob: { type: "string", format: "date" },
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
    "DELETE /:id": {
      operationId: "PatientsController_delete",
      summary: "Soft delete patient"
    },
    "GET /:id/history": {
      operationId: "PatientsController_listHistory",
      summary: "List patient history notes"
    },
    "POST /:id/history": {
      operationId: "PatientsController_addHistory",
      summary: "Add patient history note",
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["note"],
        properties: {
          note: { type: "string", minLength: 1, maxLength: 1000 }
        }
      },
      bodyExample: {
        note: "Observed for 24 hours"
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

  const assertPatientExists = async (organizationId: string, patientId: number): Promise<void> => {
    const row = await app.readDb
      .select({ id: patients.id })
      .from(patients)
      .where(
        and(
          eq(patients.id, patientId),
          eq(patients.organizationId, organizationId),
          isNull(patients.deletedAt)
        )
      )
      .limit(1);

    assertOrThrow(row.length === 1, 404, "Patient not found");
  };

  const readPatientHistory = async (organizationId: string, patientId: number) => {
    const rows = await app.readDb
      .select({
        id: patientHistoryEntries.id,
        note: patientHistoryEntries.note,
        createdAt: patientHistoryEntries.createdAt,
        createdByUserId: patientHistoryEntries.createdByUserId,
        createdByFirstName: users.firstName,
        createdByLastName: users.lastName,
        createdByRole: users.role
      })
      .from(patientHistoryEntries)
      .innerJoin(users, eq(patientHistoryEntries.createdByUserId, users.id))
      .where(
        and(
          eq(patientHistoryEntries.patientId, patientId),
          eq(patientHistoryEntries.organizationId, organizationId),
          isNull(patientHistoryEntries.deletedAt)
        )
      )
      .orderBy(desc(patientHistoryEntries.createdAt));

    return rows.map(serializePatientHistoryEntry);
  };

  const syncPatientSearch = async (row: {
    id: number;
    organizationId: string;
    fullName: string | null;
    firstName: string;
    lastName: string;
    nic: string | null;
    phone: string | null;
    dob: string | null;
    createdAt: Date;
  }) => {
    await app.searchService.upsertPatient({
      id: row.id,
      organizationId: row.organizationId,
      name: row.fullName ?? `${row.firstName} ${row.lastName}`.trim(),
      nic: row.nic,
      phone: row.phone,
      dateOfBirth: row.dob,
      createdAt: row.createdAt.toISOString()
    });
  };

  const invalidatePatientProfile = async (organizationId: string, patientId: number): Promise<void> => {
    await app.cacheService.invalidate("patientProfile", patientProfileCacheKey(organizationId, patientId));
  };

  app.get(
    "/",
    {
      preHandler: app.authorizePermissions(["patient.read"]),
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
      return { patients: rows.map(serializePatientSummary) };
    }
  );

  app.post(
    "/",
    {
      preHandler: app.authorizePermissions(["patient.write"]),
      schema: {
        tags: [tag],
        operationId: "PatientsController_create",
        summary: "Create patient"
      }
    },
    async (request, reply) => {
      const actor = request.actor!;
      const useFrontendPayload =
        hasAnyKey(request.body, ["name", "dateOfBirth", "phone", "address"]) ||
        !hasAnyKey(request.body, ["firstName", "lastName", "gender"]);

      let values: {
        nic?: string | null;
        firstName: string;
        lastName: string;
        dob: string;
        age: number;
        gender: "male" | "female" | "other";
        phone?: string | null;
        address?: string | null;
        bloodGroup?: string | null;
        familyId?: number | null;
      };

      if (useFrontendPayload) {
        const payload = parseOrThrowValidation(createPatientFrontendSchema, request.body);
        const nameParts = assertFrontendNameHasFirstAndLast(payload.name);
        const derivedAge = calculateValidatedAge(payload.dateOfBirth, payload.age);

        values = {
          nic: payload.nic ?? null,
          firstName: nameParts.firstName,
          lastName: nameParts.lastName,
          dob: payload.dateOfBirth,
          age: derivedAge,
          gender: payload.gender ?? "other",
          phone: payload.phone ?? payload.mobile ?? null,
          address: payload.address ?? null
        };
      } else {
        const payload = parseOrThrowValidation(createPatientSchema.strict(), request.body);
        const derivedAge = calculateValidatedAge(payload.dob, payload.age);

        values = {
          nic: payload.nic ?? null,
          firstName: payload.firstName,
          lastName: payload.lastName,
          dob: payload.dob,
          age: derivedAge,
          gender: payload.gender,
          phone: payload.phone ?? null,
          address: payload.address ?? null,
          bloodGroup: payload.bloodGroup ?? null,
          familyId: payload.familyId ?? null
        };
      }

      const inserted = await app.db
        .insert(patients)
        .values({
          organizationId: actor.organizationId,
          nic: values.nic ?? null,
          firstName: values.firstName,
          lastName: values.lastName,
          dob: values.dob,
          age: values.age,
          gender: values.gender,
          phone: values.phone ?? null,
          address: values.address ?? null,
          bloodGroup: values.bloodGroup ?? null,
          familyId: values.familyId ?? null
        })
        .returning();

      await writeAuditLog(request, {
        entityType: "patient",
        action: "create",
        entityId: inserted[0].id
      });
      await syncPatientSearch(inserted[0]);
      return reply.code(201).send({ patient: serializePatientSummary(inserted[0]) });
    }
  );

  app.get(
    "/:id",
    {
      preHandler: app.authorizePermissions(["patient.read"]),
      schema: {
        tags: [tag],
        operationId: "PatientsController_findOne",
        summary: "Get patient by id"
      }
    },
    async (request) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
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
      const history = await readPatientHistory(actor.organizationId, id);
      return {
        patient: serializePatientSummary(rows[0]),
        history
      };
    }
  );

  app.patch(
    "/:id",
    {
      preHandler: app.authorizePermissions(["patient.write"]),
      schema: {
        tags: [tag],
        operationId: "PatientsController_update",
        summary: "Update patient"
      }
    },
    async (request) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
      const useFrontendPayload =
        hasAnyKey(request.body, ["name", "dateOfBirth", "phone", "address"]) ||
        !hasAnyKey(request.body, ["firstName", "lastName", "dob", "age", "gender", "bloodGroup", "familyId", "nic"]);

      const updateData: Record<string, unknown> = {
        updatedAt: new Date()
      };

      if (useFrontendPayload) {
        const payload = parseOrThrowValidation(updatePatientFrontendSchema, request.body);
        if (payload.name !== undefined) {
          const nameParts = assertFrontendNameHasFirstAndLast(payload.name);
          updateData.firstName = nameParts.firstName;
          updateData.lastName = nameParts.lastName;
        }
        if (payload.dateOfBirth !== undefined) {
          updateData.dob = payload.dateOfBirth;
          updateData.age = calculateValidatedAge(payload.dateOfBirth, payload.age);
        }
        if (payload.nic !== undefined) {
          updateData.nic = payload.nic;
        }
        if (payload.age !== undefined && payload.dateOfBirth === undefined) {
          updateData.age = payload.age;
        }
        if (payload.gender !== undefined) {
          updateData.gender = payload.gender;
        }
        if (payload.phone !== undefined) {
          updateData.phone = payload.phone;
        } else if (payload.mobile !== undefined) {
          updateData.phone = payload.mobile;
        }
        if (payload.address !== undefined) {
          updateData.address = payload.address;
        }
      } else {
        const payload = parseOrThrowValidation(updatePatientSchema.strict(), request.body);

        if (payload.firstName !== undefined) {
          updateData.firstName = payload.firstName;
        }
        if (payload.lastName !== undefined) {
          updateData.lastName = payload.lastName;
        }

        if (payload.dob !== undefined) {
          updateData.dob = payload.dob;
          updateData.age = calculateValidatedAge(payload.dob, payload.age);
        }

        if (payload.age !== undefined && payload.dob === undefined) {
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
      await syncPatientSearch(updated[0]);
      await invalidatePatientProfile(actor.organizationId, id);
      return { patient: serializePatientSummary(updated[0]) };
    }
  );

  app.delete(
    "/:id",
    {
      preHandler: app.authorizePermissions(["patient.delete"]),
      schema: {
        tags: [tag],
        operationId: "PatientsController_delete",
        summary: "Soft delete patient"
      }
    },
    async (request) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);

      const deleted = await app.db
        .update(patients)
        .set({
          isActive: false,
          updatedAt: new Date(),
          deletedAt: new Date()
        })
        .where(
          and(
            eq(patients.id, id),
            eq(patients.organizationId, actor.organizationId),
            isNull(patients.deletedAt)
          )
        )
        .returning({ id: patients.id });

      assertOrThrow(deleted.length === 1, 404, "Patient not found");

      await writeAuditLog(request, {
        entityType: "patient",
        action: "delete",
        entityId: id
      });
      await app.searchService.deletePatient(actor.organizationId, id);
      await invalidatePatientProfile(actor.organizationId, id);

      return { success: true };
    }
  );

  app.get(
    "/:id/history",
    {
      preHandler: app.authorizePermissions(["patient.history.read"]),
      schema: {
        tags: [tag],
        operationId: "PatientsController_listHistory",
        summary: "List patient history notes"
      }
    },
    async (request) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
      await assertPatientExists(actor.organizationId, id);

      return {
        history: await readPatientHistory(actor.organizationId, id)
      };
    }
  );

  app.post(
    "/:id/history",
    {
      preHandler: app.authorizePermissions(["patient.history.write"]),
      schema: {
        tags: [tag],
        operationId: "PatientsController_addHistory",
        summary: "Add patient history note"
      }
    },
    async (request, reply) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
      await assertPatientExists(actor.organizationId, id);
      const payload = parseOrThrowValidation(createPatientHistorySchema.strict(), request.body);

      const inserted = await app.db
        .insert(patientHistoryEntries)
        .values({
          organizationId: actor.organizationId,
          patientId: id,
          createdByUserId: actor.userId,
          note: payload.note
        })
        .returning();

      await writeAuditLog(request, {
        entityType: "patient_history",
        action: "create",
        entityId: inserted[0].id
      });

      return reply.code(201).send({
        id: inserted[0].id,
        patientId: inserted[0].patientId,
        note: inserted[0].note,
        createdByUserId: inserted[0].createdByUserId
      });
    }
  );

  app.get(
    "/:id/profile",
    { preHandler: app.authorizePermissions(["patient.profile.read"]) },
    async (request) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
      const cacheKey = patientProfileCacheKey(actor.organizationId, id);
      const cached = await app.cacheService.getJson<{
        patient: unknown;
        allergies: unknown[];
        conditions: unknown[];
        vitals: unknown[];
        timeline: unknown[];
      }>("patientProfile", cacheKey);

      if (cached) {
        return cached;
      }

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

      const payload = { patient, allergies, conditions, vitals, timeline };
      await app.cacheService.setJson(
        "patientProfile",
        cacheKey,
        payload,
        app.env.PATIENT_PROFILE_CACHE_TTL_SECONDS
      );
      return payload;
    }
  );

  app.get("/:id/family", { preHandler: app.authorizePermissions(["patient.family.read"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);

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
    { preHandler: app.authorizePermissions(["patient.allergy.read"]) },
    async (request) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
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
    { preHandler: app.authorizePermissions(["patient.condition.read"]) },
    async (request) => {
      const actor = request.actor!;
      const { id } = parseOrThrowValidation(idParamSchema, request.params);
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

  app.post("/:id/conditions", { preHandler: app.authorizePermissions(["patient.condition.write"]) }, async (request, reply) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const body = parseOrThrowValidation(createPatientConditionSchema, request.body);

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
    await app.searchService.indexDiagnoses([
      {
        id: `condition:${inserted[0].id}`,
        organizationId: actor.organizationId,
        encounterId: null,
        patientId: id,
        icd10Code: inserted[0].icd10Code,
        diagnosisName: inserted[0].conditionName,
        source: "condition",
        createdAt: inserted[0].createdAt.toISOString()
      }
    ]);
    await invalidatePatientProfile(actor.organizationId, id);
    return reply.code(201).send(inserted[0]);
  });

  app.post("/:id/allergies", { preHandler: app.authorizePermissions(["patient.allergy.write"]) }, async (request, reply) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const body = parseOrThrowValidation(createPatientAllergySchema, request.body);
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
    await invalidatePatientProfile(actor.organizationId, id);
    return reply.code(201).send(inserted[0]);
  });

  app.get("/:id/vitals", { preHandler: app.authorizePermissions(["patient.vital.read"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
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

  app.post("/:id/vitals", { preHandler: app.authorizePermissions(["patient.vital.write"]) }, async (request, reply) => {
    const actor = request.actor!;
    const params = parseOrThrowValidation(idParamSchema, request.params);
    const payload = parseOrThrowValidation(createVitalSchema, {
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
    await invalidatePatientProfile(actor.organizationId, params.id);
    return reply.code(201).send(inserted[0]);
  });

  app.get("/:id/timeline", { preHandler: app.authorizePermissions(["patient.timeline.read"]) }, async (request) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
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

  app.post("/:id/timeline", { preHandler: app.authorizePermissions(["patient.timeline.write"]) }, async (request, reply) => {
    const actor = request.actor!;
    const { id } = parseOrThrowValidation(idParamSchema, request.params);
    const body = parseOrThrowValidation(createPatientTimelineEventSchema, request.body);

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
    await invalidatePatientProfile(actor.organizationId, id);
    return reply.code(201).send(inserted[0]);
  });
};

export default patientRoutes;

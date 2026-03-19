import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import {
  families,
  familyMembers,
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

const buildPatientCode = (): string => {
  const timePart = Date.now().toString(36).toUpperCase();
  const randomPart = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `P-${timePart}-${randomPart}`;
};

const buildFamilyCode = (): string => {
  const timePart = Date.now().toString(36).toUpperCase();
  const randomPart = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `F-${timePart}-${randomPart}`;
};

type PatientWriteValues = {
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
  familyCode?: string | null;
  allergies?: { allergyName: string; severity?: "low" | "moderate" | "high" | null; isActive?: boolean }[] | null;
  guardianPatientId?: number | null;
  guardianName?: string | null;
  guardianNic?: string | null;
  guardianPhone?: string | null;
  guardianRelationship?: string | null;
};

const ensureMinorGuardianDetails = (values: PatientWriteValues): void => {
  if (values.age >= 18 || values.nic) {
    return;
  }

  if (!values.guardianPatientId && !values.guardianName) {
    throw validationError([
      {
        field: "guardianName",
        message: "Guardian details are required for minors without an NIC."
      }
    ]);
  }

  if (!values.guardianPatientId && !values.guardianNic && !values.guardianPhone) {
    throw validationError([
      {
        field: "guardianNic",
        message: "Guardian NIC or phone is required for minors without an NIC."
      }
    ]);
  }
};

const patientProfileCacheKey = (organizationId: string, patientId: number): string =>
  `${organizationId}:${patientId}`;

const createPatientBodySchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["name", "dateOfBirth"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        nic: { type: "string", nullable: true },
        age: { type: "integer", minimum: 0, maximum: 130 },
        gender: { type: "string", enum: ["male", "female", "other"] },
        mobile: { type: "string", nullable: true },
        priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
        dateOfBirth: { type: "string", format: "date" },
        phone: { type: "string", nullable: true },
        address: { type: "string", nullable: true },
        familyId: { type: "integer", minimum: 1, nullable: true },
        guardianPatientId: { type: "integer", minimum: 1, nullable: true },
        guardianName: { type: "string", nullable: true },
        guardianNic: { type: "string", nullable: true },
        guardianPhone: { type: "string", nullable: true },
        guardianRelationship: { type: "string", nullable: true },
        bloodGroup: { type: "string", nullable: true },
        familyCode: { type: "string", nullable: true },
        allergies: {
          type: "array",
          nullable: true,
          items: {
            type: "object",
            required: ["allergyName"],
            properties: {
              allergyName: { type: "string", minLength: 1 },
              severity: { type: "string", enum: ["low", "moderate", "high"], nullable: true },
              isActive: { type: "boolean" }
            }
          }
        }
      }
    },
    {
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
        familyId: { type: "integer", minimum: 1, nullable: true },
        familyCode: { type: "string", nullable: true },
        guardianPatientId: { type: "integer", minimum: 1, nullable: true },
        guardianName: { type: "string", nullable: true },
        guardianNic: { type: "string", nullable: true },
        guardianPhone: { type: "string", nullable: true },
        guardianRelationship: { type: "string", nullable: true },
        allergies: {
          type: "array",
          nullable: true,
          items: {
            type: "object",
            required: ["allergyName"],
            properties: {
              allergyName: { type: "string", minLength: 1 },
              severity: { type: "string", enum: ["low", "moderate", "high"], nullable: true },
              isActive: { type: "boolean" }
            }
          }
        }
      }
    }
  ],
  example: {
    name: "Kamal Silva",
    dateOfBirth: "1999-06-10",
    gender: "male",
    phone: "+94770000001",
    address: "Colombo"
  }
} as const;

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
      bodySchema: createPatientBodySchema,
      bodyExamples: {
        frontend: {
          summary: "Frontend-compatible payload",
          value: {
            name: "Kamal Silva",
            dateOfBirth: "1999-06-10",
            gender: "male",
            phone: "+94770000001",
            address: "Colombo"
          }
        },
        backend: {
          summary: "Direct API payload",
          value: {
            nic: "199912345678",
            firstName: "Kamal",
            lastName: "Silva",
            dob: "1999-06-10",
            gender: "male",
            phone: "+94770000001",
            address: "Colombo",
            bloodGroup: "B+",
            familyId: 1,
            guardianPatientId: 2,
            guardianRelationship: "mother"
          }
        }
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
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1, maxLength: 120 },
              nic: { type: "string", nullable: true },
              age: { type: "integer", minimum: 0, maximum: 130 },
              gender: { type: "string", enum: ["male", "female", "other"], nullable: true },
              mobile: { type: "string", nullable: true },
              priority: { type: "string", enum: ["low", "normal", "high", "critical"], nullable: true },
              dateOfBirth: { type: "string", format: "date" },
              phone: { type: "string", nullable: true },
              address: { type: "string", nullable: true },
              familyId: { type: "integer", minimum: 1, nullable: true },
              guardianPatientId: { type: "integer", minimum: 1, nullable: true },
              guardianName: { type: "string", nullable: true },
              guardianNic: { type: "string", nullable: true },
              guardianPhone: { type: "string", nullable: true },
              guardianRelationship: { type: "string", nullable: true }
            }
          },
          {
            type: "object",
            additionalProperties: false,
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
              familyId: { type: "integer", minimum: 1, nullable: true },
              guardianPatientId: { type: "integer", minimum: 1, nullable: true },
              guardianName: { type: "string", nullable: true },
              guardianNic: { type: "string", nullable: true },
              guardianPhone: { type: "string", nullable: true },
              guardianRelationship: { type: "string", nullable: true }
            }
          }
        ]
      },
      bodyExamples: {
        frontend: {
          summary: "Frontend-compatible payload",
          value: {
            address: "No.10, Main Street, Colombo",
            phone: "+94770000002"
          }
        },
        backend: {
          summary: "Direct API payload",
          value: {
            firstName: "Kamal",
            lastName: "Perera",
            bloodGroup: "B+"
          }
        }
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

  const assertFamilyExists = async (organizationId: string, familyId: number, tx?: any): Promise<void> => {
    const db = tx ?? app.readDb;
    const row = await db
      .select({ id: families.id })
      .from(families)
      .where(and(eq(families.id, familyId), eq(families.organizationId, organizationId), isNull(families.deletedAt)))
      .limit(1);

    assertOrThrow(row.length === 1, 404, "Family not found");
  };

  const resolveGuardianValues = async (
    organizationId: string,
    patientId: number | null,
    values: PatientWriteValues,
    tx?: any
  ): Promise<PatientWriteValues> => {
    const db = tx ?? app.readDb;
    ensureMinorGuardianDetails(values);

    if (values.guardianPatientId) {
      const guardianRows = await db
        .select({
          id: patients.id,
          familyId: patients.familyId,
          firstName: patients.firstName,
          lastName: patients.lastName,
          nic: patients.nic,
          phone: patients.phone
        })
        .from(patients)
        .where(
          and(
            eq(patients.id, values.guardianPatientId),
            eq(patients.organizationId, organizationId),
            isNull(patients.deletedAt)
          )
        )
        .limit(1);

      assertOrThrow(guardianRows.length === 1, 404, "Guardian patient not found");
      const guardian = guardianRows[0];
      assertOrThrow(patientId === null || guardian.id !== patientId, 400, "Patient cannot be their own guardian");

      if (values.familyId && guardian.familyId && values.familyId !== guardian.familyId) {
        throw validationError([
          {
            field: "familyId",
            message: "Guardian patient must belong to the same family."
          }
        ]);
      }

      const effectiveFamilyId = values.familyId ?? guardian.familyId ?? null;
      if (!effectiveFamilyId) {
        throw validationError([
          {
            field: "familyId",
            message: "Guardian-linked patients must be assigned to a family."
          }
        ]);
      }

      return {
        ...values,
        familyId: effectiveFamilyId,
        guardianName: values.guardianName ?? `${guardian.firstName} ${guardian.lastName}`.trim(),
        guardianNic: values.guardianNic ?? guardian.nic ?? null,
        guardianPhone: values.guardianPhone ?? guardian.phone ?? null
      };
    }

    return values;
  };

  const ensureFamilyMembership = async (
    organizationId: string,
    familyId: number | null | undefined,
    patientId: number,
    relationship: string | null,
    tx?: any
  ): Promise<void> => {
    if (!familyId) {
      return;
    }

    const db = tx ?? app.db;
    const readDb = tx ?? app.readDb;

    const existing = await readDb
      .select({ id: familyMembers.id, relationship: familyMembers.relationship })
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.organizationId, organizationId),
          eq(familyMembers.familyId, familyId),
          eq(familyMembers.patientId, patientId)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(familyMembers).values({
        organizationId,
        familyId,
        patientId,
        relationship
      });
      return;
    }

    if (relationship && existing[0].relationship !== relationship) {
      await db
        .update(familyMembers)
        .set({ relationship, updatedAt: new Date() })
        .where(eq(familyMembers.id, existing[0].id));
    }
  };

  const syncPatientSearch = async (row: {
    id: number;
    organizationId: string;
    patientCode: string | null;
    fullName: string | null;
    firstName: string;
    lastName: string;
    nic: string | null;
    phone: string | null;
    guardianName: string | null;
    guardianNic: string | null;
    guardianPhone: string | null;
    dob: string | null;
    createdAt: Date;
  }) => {
    await app.searchService.upsertPatient({
      id: row.id,
      organizationId: row.organizationId,
      patientCode: row.patientCode,
      name: row.fullName ?? `${row.firstName} ${row.lastName}`.trim(),
      nic: row.nic,
      phone: row.phone,
      guardianName: row.guardianName,
      guardianNic: row.guardianNic,
      guardianPhone: row.guardianPhone,
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
        .select({
          id: patients.id,
          patientCode: patients.patientCode,
          fullName: patients.fullName,
          firstName: patients.firstName,
          lastName: patients.lastName,
          dob: patients.dob,
          phone: patients.phone,
          address: patients.address,
          familyId: patients.familyId,
          guardianPatientId: patients.guardianPatientId,
          createdAt: patients.createdAt
        })
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
        summary: "Create patient",
        body: createPatientBodySchema
      }
    },
    async (request, reply) => {
      const actor = request.actor!;
      const useFrontendPayload =
        hasAnyKey(request.body, ["name", "dateOfBirth", "mobile"]) ||
        !hasAnyKey(request.body, ["firstName", "lastName", "dob"]);

      let values: PatientWriteValues;

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
          address: payload.address ?? null,
          bloodGroup: payload.bloodGroup ?? null,
          familyId: payload.familyId ?? null,
          familyCode: payload.familyCode ?? null,
          allergies: payload.allergies ?? null,
          guardianPatientId: payload.guardianPatientId ?? null,
          guardianName: payload.guardianName ?? null,
          guardianNic: payload.guardianNic ?? null,
          guardianPhone: payload.guardianPhone ?? null,
          guardianRelationship: payload.guardianRelationship ?? null
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
          familyId: payload.familyId ?? null,
          familyCode: payload.familyCode ?? null,
          allergies: payload.allergies ?? null,
          guardianPatientId: payload.guardianPatientId ?? null,
          guardianName: payload.guardianName ?? null,
          guardianNic: payload.guardianNic ?? null,
          guardianPhone: payload.guardianPhone ?? null,
          guardianRelationship: payload.guardianRelationship ?? null
        };
      }

      return app.db.transaction(async (tx) => {
        values = await resolveGuardianValues(actor.organizationId, null, values, tx);

        if (!values.familyId) {
          if (values.familyCode) {
            const familyRows = await tx
              .select({ id: families.id })
              .from(families)
              .where(
                and(
                  eq(families.familyCode, values.familyCode),
                  eq(families.organizationId, actor.organizationId),
                  isNull(families.deletedAt)
                )
              )
              .limit(1);

            if (familyRows.length > 0) {
              values.familyId = familyRows[0].id;
            } else {
              // Identify family by the full name of the first registered member (Nimal Perera Family)
              // This prevents "Silva Family (1)", "Silva Family (2)" confusion.
              const familyName = `${values.firstName} ${values.lastName} Family`;

              const newFamily = await tx
                .insert(families)
                .values({
                  organizationId: actor.organizationId,
                  familyCode: values.familyCode,
                  familyName,
                  assigned: true
                })
                .returning();
              values.familyId = newFamily[0].id;
            }
          } else {
            // Auto-create family if neither ID nor Code provided (Nimal Perera Family)
            const familyCode = buildFamilyCode();
            const familyName = `${values.firstName} ${values.lastName} Family`;

            const newFamily = await tx
              .insert(families)
              .values({
                organizationId: actor.organizationId,
                familyCode,
                familyName,
                assigned: true
              })
              .returning();
            
            values.familyId = newFamily[0].id;
            values.familyCode = familyCode;
          }
        }

        const inserted = await tx
          .insert(patients)
          .values({
            organizationId: actor.organizationId,
            patientCode: buildPatientCode(),
            nic: values.nic ?? null,
            firstName: values.firstName,
            lastName: values.lastName,
            dob: values.dob,
            age: values.age,
            gender: values.gender,
            phone: values.phone ?? null,
            address: values.address ?? null,
            bloodGroup: values.bloodGroup ?? null,
            familyId: values.familyId ?? null,
            guardianPatientId: values.guardianPatientId ?? null,
            guardianName: values.guardianName ?? null,
            guardianNic: values.guardianNic ?? null,
            guardianPhone: values.guardianPhone ?? null,
            guardianRelationship: values.guardianRelationship ?? null
          })
          .returning();

        // Use tx for ensuing calls within transaction
        await ensureFamilyMembership(
          actor.organizationId,
          values.familyId,
          inserted[0].id,
          values.age < 18 ? "child" : values.guardianRelationship ?? null,
          tx // Passing transaction if supported by your helper, otherwise use app.db
        );

        if (values.allergies && values.allergies.length > 0) {
          await tx.insert(patientAllergies).values(
            values.allergies.map((a) => ({
              organizationId: actor.organizationId,
              patientId: inserted[0].id,
              allergyName: a.allergyName,
              severity: a.severity ?? null,
              isActive: a.isActive ?? true
            }))
          );
        }

        await writeAuditLog(request, {
          entityType: "patient",
          action: "create",
          entityId: inserted[0].id
        });
        await syncPatientSearch(inserted[0]);

        return reply.code(201).send({ patient: serializePatientSummary(inserted[0]) });
      });
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
        .select({
          id: patients.id,
          patientCode: patients.patientCode,
          fullName: patients.fullName,
          firstName: patients.firstName,
          lastName: patients.lastName,
          dob: patients.dob,
          phone: patients.phone,
          address: patients.address,
          familyId: patients.familyId,
          guardianPatientId: patients.guardianPatientId,
          createdAt: patients.createdAt
        })
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
        hasAnyKey(request.body, ["name", "dateOfBirth", "mobile"]) ||
        !hasAnyKey(request.body, [
          "firstName",
          "lastName",
          "dob",
          "age",
          "gender",
          "bloodGroup",
          "familyId",
          "familyCode",
          "allergies",
          "nic",
          "guardianPatientId",
          "guardianName",
          "guardianNic",
          "guardianPhone",
          "guardianRelationship"
        ]);

      const [existingPatient] = await app.readDb
        .select()
        .from(patients)
        .where(and(eq(patients.id, id), eq(patients.organizationId, actor.organizationId), isNull(patients.deletedAt)))
        .limit(1);
      assertOrThrow(existingPatient, 404, "Patient not found");

      const updateData: Record<string, unknown> = {
        updatedAt: new Date()
      };
      let requestedFamilyCode: string | null | undefined;
      let pendingAllergies:
        | Array<{ allergyName: string; severity?: "low" | "moderate" | "high" | null; isActive?: boolean | null }>
        | null
        | undefined;

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
        if (payload.bloodGroup !== undefined) {
          updateData.bloodGroup = payload.bloodGroup;
        }
        if (payload.familyCode !== undefined && payload.familyCode !== null) {
          requestedFamilyCode = payload.familyCode;
        }
        if (payload.allergies !== undefined && payload.allergies !== null) {
          pendingAllergies = payload.allergies;
        }
        if (payload.guardianPatientId !== undefined) {
          updateData.guardianPatientId = payload.guardianPatientId;
        }
        if (payload.guardianName !== undefined) {
          updateData.guardianName = payload.guardianName;
        }
        if (payload.guardianNic !== undefined) {
          updateData.guardianNic = payload.guardianNic;
        }
        if (payload.guardianPhone !== undefined) {
          updateData.guardianPhone = payload.guardianPhone;
        }
        if (payload.guardianRelationship !== undefined) {
          updateData.guardianRelationship = payload.guardianRelationship;
        }
      } else {
        const payload = parseOrThrowValidation(updatePatientSchema, request.body);

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
        if (payload.guardianPatientId !== undefined) {
          updateData.guardianPatientId = payload.guardianPatientId;
        }
        if (payload.guardianName !== undefined) {
          updateData.guardianName = payload.guardianName;
        }
        if (payload.guardianNic !== undefined) {
          updateData.guardianNic = payload.guardianNic;
        }
        if (payload.guardianPhone !== undefined) {
          updateData.guardianPhone = payload.guardianPhone;
        }
        if (payload.guardianRelationship !== undefined) {
          updateData.guardianRelationship = payload.guardianRelationship;
        }
      }

      const resolvedValues = await resolveGuardianValues(actor.organizationId, id, {
        nic: (updateData.nic as string | null | undefined) ?? existingPatient.nic,
        firstName: (updateData.firstName as string | undefined) ?? existingPatient.firstName,
        lastName: (updateData.lastName as string | undefined) ?? existingPatient.lastName,
        dob: (updateData.dob as string | undefined) ?? existingPatient.dob,
        age: (updateData.age as number | undefined) ?? existingPatient.age,
        gender: (updateData.gender as "male" | "female" | "other" | undefined) ?? existingPatient.gender,
        phone: (updateData.phone as string | null | undefined) ?? existingPatient.phone,
        address: (updateData.address as string | null | undefined) ?? existingPatient.address,
        bloodGroup: (updateData.bloodGroup as string | null | undefined) ?? existingPatient.bloodGroup,
        familyId: (updateData.familyId as number | null | undefined) ?? existingPatient.familyId,
        guardianPatientId:
          (updateData.guardianPatientId as number | null | undefined) ?? existingPatient.guardianPatientId,
        guardianName: (updateData.guardianName as string | null | undefined) ?? existingPatient.guardianName,
        guardianNic: (updateData.guardianNic as string | null | undefined) ?? existingPatient.guardianNic,
        guardianPhone: (updateData.guardianPhone as string | null | undefined) ?? existingPatient.guardianPhone,
        guardianRelationship:
          (updateData.guardianRelationship as string | null | undefined) ?? existingPatient.guardianRelationship
      });

      if (requestedFamilyCode) {
        const familyRows = await app.readDb
          .select({ id: families.id })
          .from(families)
          .where(
            and(
              eq(families.familyCode, requestedFamilyCode),
              eq(families.organizationId, actor.organizationId),
              isNull(families.deletedAt)
            )
          )
          .limit(1);

        if (familyRows.length > 0) {
          resolvedValues.familyId = familyRows[0].id;
        }
      }

      if (resolvedValues.familyId) {
        await assertFamilyExists(actor.organizationId, resolvedValues.familyId);
      }

      updateData.familyId = resolvedValues.familyId ?? null;
      updateData.guardianPatientId = resolvedValues.guardianPatientId ?? null;
      updateData.guardianName = resolvedValues.guardianName ?? null;
      updateData.guardianNic = resolvedValues.guardianNic ?? null;
      updateData.guardianPhone = resolvedValues.guardianPhone ?? null;
      updateData.guardianRelationship = resolvedValues.guardianRelationship ?? null;

      return app.db.transaction(async (tx) => {
        if (requestedFamilyCode && !resolvedValues.familyId) {
          const familyName = `${resolvedValues.firstName} ${resolvedValues.lastName} Family`;
          const newFamily = await tx
            .insert(families)
            .values({
              organizationId: actor.organizationId,
              familyCode: requestedFamilyCode,
              familyName,
              assigned: true
            })
            .returning({ id: families.id });
          resolvedValues.familyId = newFamily[0].id;
          updateData.familyId = newFamily[0].id;
        }

        const updated = await tx
          .update(patients)
          .set(updateData)
          .where(and(eq(patients.id, id), eq(patients.organizationId, actor.organizationId), isNull(patients.deletedAt)))
          .returning();

        assertOrThrow(updated.length === 1, 404, "Patient not found");

        if (pendingAllergies !== undefined && pendingAllergies !== null) {
          await tx
            .delete(patientAllergies)
            .where(and(eq(patientAllergies.organizationId, actor.organizationId), eq(patientAllergies.patientId, id)));

          if (pendingAllergies.length > 0) {
            await tx.insert(patientAllergies).values(
              pendingAllergies.map((a) => ({
                organizationId: actor.organizationId,
                patientId: id,
                allergyName: a.allergyName,
                severity: a.severity ?? null,
                isActive: a.isActive ?? true
              }))
            );
          }
        }

        await writeAuditLog(request, {
          entityType: "patient",
          action: "update",
          entityId: id
        });
        await ensureFamilyMembership(
          actor.organizationId,
          resolvedValues.familyId,
          id,
          resolvedValues.age < 18 ? "child" : resolvedValues.guardianRelationship ?? null,
          tx
        );
        await syncPatientSearch(updated[0]);
        await invalidatePatientProfile(actor.organizationId, id);
        return { patient: serializePatientSummary(updated[0]) };
      });
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
      .select({
        familyId: patients.familyId,
        guardianPatientId: patients.guardianPatientId,
        guardianRelationship: patients.guardianRelationship
      })
      .from(patients)
      .where(and(eq(patients.id, id), eq(patients.organizationId, actor.organizationId), isNull(patients.deletedAt)))
      .limit(1);
    assertOrThrow(row.length === 1, 404, "Patient not found");

    if (!row[0].familyId) {
      return {
        familyId: null,
        family: null,
        guardianPatientId: row[0].guardianPatientId,
        guardianRelationship: row[0].guardianRelationship,
        members: []
      };
    }

    const [family, members] = await Promise.all([
      app.readDb
        .select({ id: families.id, familyCode: families.familyCode, familyName: families.familyName })
        .from(families)
        .where(
          and(
            eq(families.id, row[0].familyId),
            eq(families.organizationId, actor.organizationId),
            isNull(families.deletedAt)
          )
        )
        .limit(1),
      app.readDb
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
            eq(familyMembers.familyId, row[0].familyId),
            eq(familyMembers.organizationId, actor.organizationId),
            isNull(patients.deletedAt)
          )
        )
    ]);

    return {
      familyId: row[0].familyId,
      family: family[0] ?? null,
      guardianPatientId: row[0].guardianPatientId,
      guardianRelationship: row[0].guardianRelationship,
      members
    };
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

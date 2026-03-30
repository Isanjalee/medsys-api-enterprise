import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  appointments,
  dispenseRecords,
  encounterDiagnoses,
  encounters,
  families,
  familyMembers,
  inventoryItems,
  inventoryMovements,
  patientAllergies,
  patientConditions,
  patientHistoryEntries,
  patientTimelineEvents,
  patientVitals,
  patients,
  prescriptionItems,
  prescriptions,
  testOrders
} from "@medsys/db";
import { hasAllResolvedPermissions } from "@medsys/types";
import { createGuardianFrontendSchema, createPatientFrontendSchema, saveConsultationWorkflowSchema } from "@medsys/validation";
import { serializePatientSummary, serializePatientVital } from "../../lib/api-serializers.js";
import { writeAuditLog } from "../../lib/audit.js";
import { calculateAgeFromDob } from "../../lib/date.js";
import { assertOrThrow, parseOrThrowValidation, validationError } from "../../lib/http-error.js";
import { splitFullName } from "../../lib/names.js";
import { applyRouteDocs } from "../../lib/route-docs.js";

const appointmentQueueCacheKey = (organizationId: string): string => `${organizationId}:waiting`;
const activeVisitStatuses = ["waiting", "in_consultation"] as const;
const inArrayValue = <T extends string>(value: string, values: readonly T[]): value is T => values.includes(value as T);

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

const calculateValidatedAge = (dob: string, age?: number): number => {
  const derivedAge = calculateAgeFromDob(new Date(dob));
  if (age !== undefined && Math.abs(derivedAge - age) > 1) {
    throw validationError([
      {
        field: "patientDraft.age",
        message: "Age does not match DOB."
      }
    ]);
  }
  return derivedAge;
};

const assertFrontendNameHasFirstAndLast = (fullName: string): { firstName: string; lastName: string } => {
  const nameParts = splitFullName(fullName);
  if (!nameParts.firstName.trim() || !nameParts.lastName.trim()) {
    throw validationError([
      {
        field: "patientDraft.name",
        message: "First name and last name are required."
      }
    ]);
  }
  return {
    firstName: nameParts.firstName,
    lastName: nameParts.lastName
  };
};

const ensureMinorGuardianDetails = (values: PatientWriteValues, hasGuardianDraft = false): void => {
  if (values.age >= 18 || values.nic) {
    return;
  }

  if (!values.guardianPatientId && !values.guardianName && !hasGuardianDraft) {
    throw validationError([
      {
        field: "patientDraft.guardianName",
        message: "Guardian details are required for minors without an NIC."
      }
    ]);
  }

  if (!values.guardianPatientId && !values.guardianNic && !values.guardianPhone && !hasGuardianDraft) {
    throw validationError([
      {
        field: "patientDraft.guardianNic",
        message: "Guardian NIC or phone is required for minors without an NIC."
      }
    ]);
  }
};

const saveConsultationBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    workflowType: { type: "string", enum: ["appointment", "walk_in"] },
    appointmentId: { type: "integer", minimum: 1, nullable: true },
    patientId: { type: "integer", minimum: 1, nullable: true },
    patientDraft: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["name", "dateOfBirth"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        nic: { type: "string", nullable: true },
        age: { type: "integer", minimum: 0, maximum: 130 },
        gender: { type: "string", enum: ["male", "female", "other"], nullable: true },
        mobile: { type: "string", nullable: true },
        dateOfBirth: { type: "string", format: "date" },
        phone: { type: "string", nullable: true },
        address: { type: "string", nullable: true },
        bloodGroup: { type: "string", nullable: true },
        familyCode: { type: "string", nullable: true },
        familyId: { type: "integer", minimum: 1, nullable: true },
        guardianPatientId: { type: "integer", minimum: 1, nullable: true },
        guardianName: { type: "string", nullable: true },
        guardianNic: { type: "string", nullable: true },
        guardianPhone: { type: "string", nullable: true },
        guardianRelationship: { type: "string", nullable: true }
      }
    },
    guardianDraft: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["name", "dateOfBirth"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        nic: { type: "string", nullable: true },
        age: { type: "integer", minimum: 0, maximum: 130 },
        gender: { type: "string", enum: ["male", "female", "other"], nullable: true },
        mobile: { type: "string", nullable: true },
        dateOfBirth: { type: "string", format: "date" },
        phone: { type: "string", nullable: true },
        address: { type: "string", nullable: true },
        bloodGroup: { type: "string", nullable: true },
        familyCode: { type: "string", nullable: true },
        familyId: { type: "integer", minimum: 1, nullable: true }
      }
    },
    doctorId: { type: "integer", minimum: 1, nullable: true },
    assistantId: { type: "integer", minimum: 1, nullable: true },
    checkedAt: { type: "string", format: "date-time" },
    scheduledAt: { type: "string", format: "date-time", nullable: true },
    reason: { type: "string", nullable: true },
    priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
    notes: { type: "string", nullable: true },
    clinicalSummary: { type: "string", nullable: true },
    nextVisitDate: { type: "string", format: "date", nullable: true },
    vitals: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      properties: {
        bpSystolic: { type: "integer", minimum: 30, maximum: 300, nullable: true },
        bpDiastolic: { type: "integer", minimum: 20, maximum: 200, nullable: true },
        heartRate: { type: "integer", minimum: 20, maximum: 300, nullable: true },
        temperatureC: { type: "number", minimum: 25, maximum: 45, nullable: true },
        spo2: { type: "integer", minimum: 0, maximum: 100, nullable: true },
        recordedAt: { type: "string", format: "date-time", nullable: true }
      }
    },
    diagnoses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["diagnosisName"],
        properties: {
          diagnosisName: { type: "string" },
          icd10Code: { type: "string", nullable: true },
          persistAsCondition: { type: "boolean" }
        }
      }
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["testName"],
        properties: {
          testName: { type: "string" },
          status: {
            type: "string",
            enum: ["ordered", "in_progress", "completed", "cancelled"]
          }
        }
      }
    },
    allergies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["allergyName"],
        properties: {
          allergyName: { type: "string", minLength: 1 },
          severity: { type: "string", enum: ["low", "moderate", "high"], nullable: true },
          isActive: { type: "boolean" }
        }
      }
    },
    prescription: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["drugName", "dose", "frequency", "quantity", "source"],
            properties: {
              drugName: { type: "string" },
              dose: { type: "string" },
              frequency: { type: "string" },
              duration: { type: "string", nullable: true },
              quantity: { type: "number", minimum: 0.01 },
              source: { type: "string", enum: ["clinical", "outside"] }
            }
          }
        }
      }
    },
    dispense: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      properties: {
        mode: {
          type: "string",
          enum: ["assistant_queue", "doctor_direct"]
        },
        dispensedAt: { type: "string", format: "date-time", nullable: true },
        notes: { type: "string", nullable: true },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["inventoryItemId", "quantity"],
            properties: {
              inventoryItemId: { type: "integer", minimum: 1 },
              quantity: { type: "number", minimum: 0.01 }
            }
          }
        }
      }
    }
  },
  example: {
    workflowType: "walk_in",
    patientDraft: {
      name: "Kamal Silva",
      dateOfBirth: "1999-06-10",
      nic: "199912345678",
      gender: "male",
      phone: "+94770000001"
    },
    guardianDraft: {
      name: "Saman Silva",
      dateOfBirth: "1988-02-15",
      nic: "198812345678",
      gender: "male",
      phone: "+94770000002"
    },
    checkedAt: "2026-03-24T10:30:00Z",
    reason: "Walk-in consultation",
    priority: "normal",
    clinicalSummary: "Seen for walk-in fever review. Supportive care advised.",
    diagnoses: [{ diagnosisName: "Acute viral fever", icd10Code: "B34.9" }],
    tests: [{ testName: "CBC", status: "ordered" }],
    prescription: {
      items: [
        {
          drugName: "Paracetamol",
          dose: "500mg",
          frequency: "TID",
          duration: "3 days",
          quantity: 9,
          source: "clinical"
        }
      ]
    },
    dispense: {
      mode: "assistant_queue"
    }
  }
} as const;

const validationErrorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error", "issues"],
  properties: {
    error: { type: "string", example: "Validation failed." },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "message"],
        properties: {
          field: { type: "string" },
          message: { type: "string" }
        }
      }
    }
  }
} as const;

const messageErrorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string" }
  }
} as const;

const saveConsultationSuccessResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "patient",
    "patient_created",
    "visit",
    "appointment_id",
    "encounter_id",
    "prescription_id",
    "vital",
    "workflow_type",
    "workflow_status",
    "dispense_status",
    "doctor_direct_dispense",
    "clinical_item_count",
    "outside_item_count"
  ],
  properties: {
    patient: {
      type: "object",
      additionalProperties: true
    },
    patient_created: { type: "boolean" },
    visit: {
      type: "object",
      additionalProperties: false,
      required: ["id", "patient_id", "doctor_id", "assistant_id", "scheduled_at", "status", "reason", "priority"],
      properties: {
        id: { type: "integer" },
        patient_id: { type: "integer" },
        doctor_id: { type: "integer", nullable: true },
        assistant_id: { type: "integer", nullable: true },
        scheduled_at: { type: "string", format: "date-time" },
        status: { type: "string" },
        reason: { type: "string", nullable: true },
        priority: { type: "string", enum: ["low", "normal", "high", "critical"] }
      }
    },
    appointment_id: { type: "integer", nullable: true },
    encounter_id: { type: "integer" },
    prescription_id: { type: "integer", nullable: true },
    vital: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: true
        }
      ]
    },
    workflow_type: { type: "string", enum: ["appointment", "walk_in"] },
    workflow_status: { type: "string", enum: ["doctor_completed", "ready_for_dispense", "completed"] },
    dispense_status: { type: "string", enum: ["none", "pending", "completed"] },
    doctor_direct_dispense: { type: "boolean" },
    clinical_item_count: { type: "integer", minimum: 0 },
    outside_item_count: { type: "integer", minimum: 0 }
  },
  example: {
    patient: {
      id: 38,
      patient_code: "P-000000038",
      full_name: "Nith Hadaz"
    },
    patient_created: false,
    visit: {
      id: 90,
      patient_id: 38,
      doctor_id: 10,
      assistant_id: 3,
      scheduled_at: "2026-03-24T16:59:07.445Z",
      status: "in_consultation",
      reason: "Walk-in consultation",
      priority: "normal"
    },
    appointment_id: 90,
    encounter_id: 120,
    prescription_id: 44,
    vital: null,
    workflow_type: "appointment",
    workflow_status: "doctor_completed",
    dispense_status: "pending",
    doctor_direct_dispense: false,
    clinical_item_count: 1,
    outside_item_count: 1
  }
} as const;

const consultationRoutes: FastifyPluginAsync = async (app) => {
  applyRouteDocs(app, "Consultations", "ConsultationsController", {
    "POST /save": {
      operationId: "ConsultationsController_save",
      summary: "Save a consultation, creating the patient first when needed",
      bodySchema: saveConsultationBodySchema,
      bodyExample: saveConsultationBodySchema.example
    }
  });

  app.addHook("preHandler", app.authenticate);

  app.post(
    "/save",
    {
      preHandler: app.authorizePermissions(["patient.write", "appointment.create", "encounter.write"]),
      schema: {
        tags: ["Consultations"],
        operationId: "ConsultationsController_save",
        summary: "Save a consultation, creating the patient first when needed",
        body: saveConsultationBodySchema,
        response: {
          201: saveConsultationSuccessResponseSchema,
          400: {
            ...validationErrorResponseSchema,
            example: {
              error: "Validation failed.",
              issues: [{ field: "patientDraft.name", message: "First name and last name are required." }]
            }
          },
          403: {
            ...messageErrorResponseSchema,
            example: { message: "Forbidden" }
          },
          404: {
            ...messageErrorResponseSchema,
            example: { message: "Appointment not found" }
          },
          409: {
            ...messageErrorResponseSchema,
            example: {
              message:
                "Active walk-in consultation already exists for this patient. Complete or dispense the current consultation before starting a new one."
            }
          },
          429: {
            ...messageErrorResponseSchema,
            example: { message: "Sensitive action rate limit exceeded" }
          },
          500: {
            ...messageErrorResponseSchema,
            example: { message: "Internal server error" }
          }
        }
      }
    },
    async (request, reply) => {
      const actor = request.actor!;
      const payload = parseOrThrowValidation(saveConsultationWorkflowSchema, request.body);
      const workflowType = payload.workflowType;
      const directDispenseRequested = payload.dispense?.mode === "doctor_direct";

      if ((payload.allergies?.length ?? 0) > 0) {
        assertOrThrow(
          hasAllResolvedPermissions(actor.permissions, ["patient.allergy.write"]),
          403,
          "Forbidden"
        );
      }

      if (directDispenseRequested) {
        assertOrThrow(
          hasAllResolvedPermissions(actor.permissions, ["prescription.dispense"]),
          403,
          "Forbidden"
        );
      }

      const resolvedDoctorId =
        payload.doctorId !== undefined ? payload.doctorId : actor.role === "doctor" ? actor.userId : null;
      const resolvedAssistantId =
        payload.assistantId !== undefined ? payload.assistantId : actor.role === "assistant" ? actor.userId : null;

      if (resolvedDoctorId === null) {
        throw validationError([
          {
            field: "doctorId",
            message: "Doctor is required to save a consultation."
          }
        ]);
      }
      const doctorId = resolvedDoctorId;
      const diagnoses = payload.diagnoses ?? [];
      const allergies = payload.allergies ?? [];
      const tests = payload.tests ?? [];
      const diagnosesToPersistAsConditions = diagnoses.filter((diagnosis) => diagnosis.persistAsCondition === true);
      const prescriptionItemsPayload = payload.prescription?.items ?? [];
      const clinicalPrescriptionItems = prescriptionItemsPayload.filter((item) => item.source === "clinical");
      const outsidePrescriptionItems = prescriptionItemsPayload.filter((item) => item.source === "outside");

      const result = await app.db.transaction(async (tx) => {
        const ensureFamilyMembership = async (
          familyId: number | null | undefined,
          patientId: number,
          relationship: string | null
        ): Promise<void> => {
          if (!familyId) {
            return;
          }

          const existing = await tx
            .select({ id: familyMembers.id, relationship: familyMembers.relationship })
            .from(familyMembers)
            .where(
              and(
                eq(familyMembers.organizationId, actor.organizationId),
                eq(familyMembers.familyId, familyId),
                eq(familyMembers.patientId, patientId)
              )
            )
            .limit(1);

          if (existing.length === 0) {
            await tx.insert(familyMembers).values({
              organizationId: actor.organizationId,
              familyId,
              patientId,
              relationship
            });
            return;
          }

          if (relationship && existing[0].relationship !== relationship) {
            await tx
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

        const createDispenseRecord = async (
          prescriptionId: number,
          items: Array<{ inventoryItemId: number; quantity: number }>
        ) => {
          const dispensingUserId = resolvedAssistantId ?? doctorId;
          const dispensedAt = new Date(payload.dispense?.dispensedAt ?? payload.checkedAt);

          const dispenseRow = await tx
            .insert(dispenseRecords)
            .values({
              organizationId: actor.organizationId,
              prescriptionId,
              assistantId: dispensingUserId,
              dispensedAt,
              status: "completed",
              notes: payload.dispense?.notes ?? null
            })
            .returning();

          for (const item of items) {
            const inventoryRows = await tx
              .select({ id: inventoryItems.id, stock: inventoryItems.stock })
              .from(inventoryItems)
              .where(
                and(
                  eq(inventoryItems.id, item.inventoryItemId),
                  eq(inventoryItems.organizationId, actor.organizationId),
                  isNull(inventoryItems.deletedAt)
                )
              )
              .limit(1);
            assertOrThrow(inventoryRows.length === 1, 404, `Inventory item ${item.inventoryItemId} not found`);

            const currentStock = Number(inventoryRows[0].stock);
            assertOrThrow(currentStock >= item.quantity, 409, "Insufficient stock");

            await tx
              .update(inventoryItems)
              .set({
                stock: sql`${inventoryItems.stock} - ${item.quantity}`,
                updatedAt: new Date()
              })
              .where(eq(inventoryItems.id, item.inventoryItemId));

            await tx.insert(inventoryMovements).values({
              organizationId: actor.organizationId,
              inventoryItemId: item.inventoryItemId,
              movementType: "out",
              quantity: item.quantity.toString(),
              referenceType: "prescription",
              referenceId: prescriptionId,
              createdById: dispensingUserId
            });
          }

          return dispenseRow[0];
        };

        const buildValuesFromFrontendDraft = (
          draft: ReturnType<typeof createPatientFrontendSchema.parse> | ReturnType<typeof createGuardianFrontendSchema.parse>
        ): PatientWriteValues => {
          const nameParts = assertFrontendNameHasFirstAndLast(draft.name);
          return {
            nic: draft.nic ?? null,
            firstName: nameParts.firstName,
            lastName: nameParts.lastName,
            dob: draft.dateOfBirth,
            age: calculateValidatedAge(draft.dateOfBirth, draft.age),
            gender: draft.gender ?? "other",
            phone: draft.phone ?? draft.mobile ?? null,
            address: draft.address ?? null,
            bloodGroup: draft.bloodGroup ?? null,
            familyId: draft.familyId ?? null,
            familyCode: draft.familyCode ?? null
          };
        };

        const ensureFamilyForValues = async (values: PatientWriteValues): Promise<PatientWriteValues> => {
          if (values.familyId) {
            return values;
          }

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

            if (familyRows.length === 1) {
              return {
                ...values,
                familyId: familyRows[0].id
              };
            }

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
            return {
              ...values,
              familyId: newFamily[0].id
            };
          }

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

          return {
            ...values,
            familyId: newFamily[0].id,
            familyCode
          };
        };

        const insertPatientRecord = async (
          values: PatientWriteValues,
          relationship: string | null
        ) => {
          const insertedRows = await tx
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
          const patient = insertedRows[0];

          await ensureFamilyMembership(values.familyId, patient.id, relationship);
          await syncPatientSearch(patient);
          return patient;
        };

        const resolveGuardianValues = async (values: PatientWriteValues): Promise<PatientWriteValues> => {
          ensureMinorGuardianDetails(values, Boolean(payload.guardianDraft));

          let guardianPatientId = values.guardianPatientId ?? null;
          if (!guardianPatientId && values.guardianNic) {
            const guardianByNic = await tx
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
                  eq(patients.organizationId, actor.organizationId),
                  eq(patients.nic, values.guardianNic),
                  isNull(patients.deletedAt)
                )
              )
              .limit(1);

            if (guardianByNic.length === 1) {
              guardianPatientId = guardianByNic[0].id;
            }
          }

          if (!guardianPatientId && payload.guardianDraft) {
            const guardianDraft = parseOrThrowValidation(createGuardianFrontendSchema, payload.guardianDraft);
            let guardianValues = buildValuesFromFrontendDraft(guardianDraft);

            if (values.familyId && !guardianValues.familyId) {
              guardianValues.familyId = values.familyId;
            }
            if (values.familyCode && !guardianValues.familyCode) {
              guardianValues.familyCode = values.familyCode;
            }

            guardianValues = await ensureFamilyForValues(guardianValues);
            const guardianPatient = await insertPatientRecord(guardianValues, values.guardianRelationship ?? "guardian");
            guardianPatientId = guardianPatient.id;

            if (!values.familyId) {
              values.familyId = guardianValues.familyId ?? null;
            }
            if (!values.familyCode) {
              values.familyCode = guardianValues.familyCode ?? null;
            }
          }

          if (!guardianPatientId) {
            return values;
          }

          const guardianRows = await tx
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
                eq(patients.id, guardianPatientId),
                eq(patients.organizationId, actor.organizationId),
                isNull(patients.deletedAt)
              )
            )
            .limit(1);

          assertOrThrow(guardianRows.length === 1, 404, "Guardian patient not found");
          const guardian = guardianRows[0];

          if (values.familyId && guardian.familyId && values.familyId !== guardian.familyId) {
            throw validationError([
              {
                field: "patientDraft.familyId",
                message: "Guardian patient must belong to the same family."
              }
            ]);
          }

          const effectiveFamilyId = values.familyId ?? guardian.familyId ?? null;
          if (!effectiveFamilyId) {
            throw validationError([
              {
                field: "patientDraft.familyId",
                message: "Guardian-linked patients must be assigned to a family."
              }
            ]);
          }

          return {
            ...values,
            familyId: effectiveFamilyId,
            guardianPatientId: guardian.id,
            guardianName: values.guardianName ?? `${guardian.firstName} ${guardian.lastName}`.trim(),
            guardianNic: values.guardianNic ?? guardian.nic ?? null,
            guardianPhone: values.guardianPhone ?? guardian.phone ?? null
          };
        };

        const resolveOrCreatePatient = async () => {
          if (payload.patientId) {
            const existingRows = await tx
              .select()
              .from(patients)
              .where(
                and(
                  eq(patients.id, payload.patientId),
                  eq(patients.organizationId, actor.organizationId),
                  isNull(patients.deletedAt)
                )
              )
              .limit(1);
            assertOrThrow(existingRows.length === 1, 404, "Patient not found");
            return { patient: existingRows[0], created: false as const };
          }

          const draft = parseOrThrowValidation(createPatientFrontendSchema, payload.patientDraft);
          let values: PatientWriteValues = {
            ...buildValuesFromFrontendDraft(draft),
            allergies: draft.allergies ?? null,
            guardianPatientId: draft.guardianPatientId ?? null,
            guardianName: draft.guardianName ?? null,
            guardianNic: draft.guardianNic ?? null,
            guardianPhone: draft.guardianPhone ?? null,
            guardianRelationship: draft.guardianRelationship ?? null
          };

          values = await resolveGuardianValues(values);
          values = await ensureFamilyForValues(values);

          const patient = await insertPatientRecord(
            values,
            values.age < 18 ? "child" : values.guardianRelationship ?? null
          );

          const patientAllergyRows = [...(values.allergies ?? []), ...allergies];
          if (patientAllergyRows.length > 0) {
            await tx.insert(patientAllergies).values(
              patientAllergyRows.map((allergy) => ({
                organizationId: actor.organizationId,
                patientId: patient.id,
                allergyName: allergy.allergyName,
                severity: allergy.severity ?? null,
                isActive: allergy.isActive ?? true
              }))
            );
          }

          return { patient, created: true as const };
        };

        const { patient, created } = await resolveOrCreatePatient();

        if (!created && allergies.length > 0) {
          await tx.insert(patientAllergies).values(
            allergies.map((allergy) => ({
              organizationId: actor.organizationId,
              patientId: patient.id,
              allergyName: allergy.allergyName,
              severity: allergy.severity ?? null,
              isActive: allergy.isActive ?? true
            }))
          );
        }

        const visit =
          workflowType === "appointment"
            ? await (async () => {
                const appointmentRows = await tx
                  .select()
                  .from(appointments)
                  .where(
                    and(
                      eq(appointments.id, payload.appointmentId as number),
                      eq(appointments.organizationId, actor.organizationId),
                      isNull(appointments.deletedAt)
                    )
                  )
                  .limit(1);
                assertOrThrow(appointmentRows.length === 1, 404, "Appointment not found");
                assertOrThrow(appointmentRows[0].patientId === patient.id, 409, "Appointment does not belong to patient");
                assertOrThrow(
                  inArrayValue(appointmentRows[0].status, activeVisitStatuses),
                  409,
                  "Appointment is not available for consultation save"
                );

                return (
                  await tx
                    .update(appointments)
                    .set({
                      status: "in_consultation",
                      doctorId: appointmentRows[0].doctorId ?? resolvedDoctorId,
                      assistantId: appointmentRows[0].assistantId ?? resolvedAssistantId,
                      updatedAt: new Date()
                    })
                    .where(
                      and(
                        eq(appointments.id, appointmentRows[0].id),
                        eq(appointments.organizationId, actor.organizationId)
                      )
                    )
                    .returning()
                )[0];
              })()
            : await (async () => {
                const activeRows = await tx
                  .select()
                  .from(appointments)
                  .where(
                    and(
                      eq(appointments.organizationId, actor.organizationId),
                      eq(appointments.patientId, patient.id),
                      inArray(appointments.status, [...activeVisitStatuses]),
                      isNull(appointments.deletedAt)
                    )
                  )
                  .orderBy(desc(appointments.scheduledAt), desc(appointments.id))
                  .limit(1);

                if (activeRows.length === 1) {
                  const existingEncounter = await tx
                    .select({ id: encounters.id })
                    .from(encounters)
                    .where(
                      and(
                        eq(encounters.organizationId, actor.organizationId),
                        eq(encounters.appointmentId, activeRows[0].id),
                        eq(encounters.patientId, patient.id),
                        isNull(encounters.deletedAt)
                      )
                    )
                    .limit(1);

                  assertOrThrow(
                    existingEncounter.length === 0,
                    409,
                    "Active walk-in consultation already exists for this patient. Complete or dispense the current consultation before starting a new one."
                  );

                  return (
                    await tx
                      .update(appointments)
                      .set({
                        status: "in_consultation",
                        doctorId: activeRows[0].doctorId ?? resolvedDoctorId,
                        assistantId: activeRows[0].assistantId ?? resolvedAssistantId,
                        updatedAt: new Date()
                      })
                      .where(
                        and(eq(appointments.id, activeRows[0].id), eq(appointments.organizationId, actor.organizationId))
                      )
                      .returning()
                  )[0];
                }

                return (
                  await tx
                    .insert(appointments)
                    .values({
                      organizationId: actor.organizationId,
                      patientId: patient.id,
                      doctorId,
                      assistantId: resolvedAssistantId,
                      scheduledAt: new Date(payload.scheduledAt ?? payload.checkedAt),
                      status: "in_consultation",
                      reason: payload.reason ?? null,
                      priority: payload.priority
                    })
                    .returning()
                )[0];
              })();

        const encounterRows = await tx
          .insert(encounters)
          .values({
            organizationId: actor.organizationId,
            appointmentId: visit.id,
            appointmentScheduledAt: visit.scheduledAt,
            patientId: patient.id,
            doctorId,
            checkedAt: new Date(payload.checkedAt),
            notes: payload.notes ?? null,
            nextVisitDate: payload.nextVisitDate ?? null,
            status: "completed"
          })
          .returning();
        const encounter = encounterRows[0];

        if (diagnoses.length > 0) {
          await tx.insert(encounterDiagnoses).values(
            diagnoses.map((diagnosis) => ({
              organizationId: actor.organizationId,
              encounterId: encounter.id,
              icd10Code: diagnosis.icd10Code ?? null,
              diagnosisName: diagnosis.diagnosisName
            }))
          );
        }

        if (tests.length > 0) {
          await tx.insert(testOrders).values(
            tests.map((test) => ({
              organizationId: actor.organizationId,
              encounterId: encounter.id,
              testName: test.testName,
              status: test.status
            }))
          );
        }

        if (diagnosesToPersistAsConditions.length > 0) {
          await tx.insert(patientConditions).values(
            diagnosesToPersistAsConditions.map((diagnosis) => ({
              organizationId: actor.organizationId,
              patientId: patient.id,
              conditionName: diagnosis.diagnosisName,
              icd10Code: diagnosis.icd10Code ?? null,
              status: "active"
            }))
          );
        }

        let vital = null;
        if (payload.vitals) {
          const vitalRows = await tx
            .insert(patientVitals)
            .values({
              organizationId: actor.organizationId,
              patientId: patient.id,
              encounterId: encounter.id,
              bpSystolic: payload.vitals.bpSystolic ?? null,
              bpDiastolic: payload.vitals.bpDiastolic ?? null,
              heartRate: payload.vitals.heartRate ?? null,
              temperatureC: payload.vitals.temperatureC?.toString() ?? null,
              spo2: payload.vitals.spo2 ?? null,
              recordedAt: new Date(payload.vitals.recordedAt ?? payload.checkedAt)
            })
            .returning();
          vital = vitalRows[0];
        }

        let prescriptionId: number | null = null;
        let dispenseStatus: "none" | "pending" | "completed" = "none";
        if (payload.prescription) {
          const prescriptionRows = await tx
            .insert(prescriptions)
            .values({
              organizationId: actor.organizationId,
              encounterId: encounter.id,
              patientId: patient.id,
              doctorId
            })
            .returning();
          prescriptionId = prescriptionRows[0].id;

          await tx.insert(prescriptionItems).values(
            prescriptionItemsPayload.map((item) => ({
              organizationId: actor.organizationId,
              prescriptionId: prescriptionId as number,
              drugName: item.drugName,
              dose: item.dose,
              frequency: item.frequency,
              duration: item.duration ?? null,
              quantity: item.quantity.toString(),
              source: item.source
            }))
          );

          if (clinicalPrescriptionItems.length === 0) {
            dispenseStatus = "none";
          } else if (directDispenseRequested) {
            await createDispenseRecord(prescriptionId, payload.dispense?.items ?? []);
            dispenseStatus = "completed";
          } else {
            dispenseStatus = "pending";
          }
        }

        const timelineTags = [
          "consultation",
          diagnoses.length > 0 ? "diagnosis" : null,
          diagnosesToPersistAsConditions.length > 0 ? "condition" : null,
          payload.prescription ? "prescription" : null,
          payload.vitals ? "vitals" : null,
          tests.length > 0 ? "tests" : null
        ].filter((tag): tag is string => Boolean(tag));

        const timelineDescriptionParts = [
          payload.reason ? `Reason: ${payload.reason}` : null,
          diagnoses.length > 0 ? `Diagnoses: ${diagnoses.map((diagnosis) => diagnosis.diagnosisName).join(", ")}` : null,
          payload.clinicalSummary ?? null
        ].filter((part): part is string => Boolean(part));

        await tx.insert(patientTimelineEvents).values({
          organizationId: actor.organizationId,
          patientId: patient.id,
          encounterId: encounter.id,
          eventDate: payload.checkedAt.slice(0, 10),
          title: "Consultation completed",
          description: timelineDescriptionParts.length > 0 ? timelineDescriptionParts.join("\n") : null,
          eventKind: "consultation",
          tags: timelineTags,
          value: `encounter:${encounter.id}`
        });

        if (payload.clinicalSummary) {
          await tx.insert(patientHistoryEntries).values({
            organizationId: actor.organizationId,
            patientId: patient.id,
            createdByUserId: actor.userId,
            note: payload.clinicalSummary
          });
        }

        const workflowStatus =
          workflowType === "appointment"
            ? clinicalPrescriptionItems.length === 0
              ? "completed"
              : directDispenseRequested
                ? "completed"
                : "doctor_completed"
            : clinicalPrescriptionItems.length === 0
              ? "completed"
              : directDispenseRequested
                ? "completed"
                : "ready_for_dispense";

        const persistedVisitStatus =
          clinicalPrescriptionItems.length === 0 || directDispenseRequested
            ? "completed"
            : "in_consultation";

        const closedVisit = (
          await tx
            .update(appointments)
            .set({ status: persistedVisitStatus, updatedAt: new Date() })
            .where(and(eq(appointments.id, visit.id), eq(appointments.organizationId, actor.organizationId)))
            .returning()
        )[0];

        return {
          patient,
          patientCreated: created,
          visit: closedVisit,
          encounterId: encounter.id,
          vital,
          prescriptionId,
          workflowType,
          workflowStatus,
          dispenseStatus,
          doctorDirectDispense: directDispenseRequested,
          clinicalItemCount: clinicalPrescriptionItems.length,
          outsideItemCount: outsidePrescriptionItems.length
        };
      });

      await writeAuditLog(request, {
        entityType: "encounter",
        action: "save_consultation_workflow",
        entityId: result.encounterId,
        payload: {
          patientId: result.patient.id,
          patientCreated: result.patientCreated,
          appointmentId: result.visit.id,
          workflowType: result.workflowType,
          workflowStatus: result.workflowStatus,
          dispenseStatus: result.dispenseStatus,
          clinicalItemCount: result.clinicalItemCount,
          outsideItemCount: result.outsideItemCount,
          hasVitals: Boolean(result.vital),
          hasPrescription: Boolean(result.prescriptionId),
          diagnosisCount: diagnoses.length,
          allergyCount: allergies.length,
          conditionCount: diagnosesToPersistAsConditions.length,
          wroteClinicalSummary: Boolean(payload.clinicalSummary)
        }
      });

      await Promise.all([
        app.cacheService.invalidate("appointmentQueue", appointmentQueueCacheKey(actor.organizationId)),
        app.cacheService.invalidate("patientProfile", `${actor.organizationId}:${result.patient.id}`),
        app.searchService.indexDiagnoses(
          diagnoses.map((diagnosis, index) => ({
            id: `encounter:${result.encounterId}:${index}`,
            organizationId: actor.organizationId,
            encounterId: result.encounterId,
            patientId: result.patient.id,
            icd10Code: diagnosis.icd10Code ?? null,
            diagnosisName: diagnosis.diagnosisName,
            source: "encounter",
            createdAt: payload.checkedAt
          }))
        )
      ]);

      return reply.code(201).send({
        patient: serializePatientSummary(result.patient),
        patient_created: result.patientCreated,
        visit: {
          id: result.visit.id,
          patient_id: result.visit.patientId,
          doctor_id: result.visit.doctorId,
          assistant_id: result.visit.assistantId,
          scheduled_at: result.visit.scheduledAt,
          status: result.visit.status,
          reason: result.visit.reason,
          priority: result.visit.priority
        },
        appointment_id: result.workflowType === "appointment" ? result.visit.id : null,
        encounter_id: result.encounterId,
        prescription_id: result.prescriptionId,
        vital: result.vital ? serializePatientVital(result.vital) : null,
        workflow_type: result.workflowType,
        workflow_status: result.workflowStatus,
        dispense_status: result.dispenseStatus,
        doctor_direct_dispense: result.doctorDirectDispense,
        clinical_item_count: result.clinicalItemCount,
        outside_item_count: result.outsideItemCount
      });
    }
  );
};

export default consultationRoutes;

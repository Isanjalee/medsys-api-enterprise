import { z } from "zod";

const USER_ROLES = ["owner", "doctor", "assistant"] as const;
const GENDERS = ["male", "female", "other"] as const;
const APPOINTMENT_STATUSES = ["waiting", "in_consultation", "completed", "cancelled"] as const;
const PRIORITY_LEVELS = ["low", "normal", "high", "critical"] as const;
const DRUG_SOURCES = ["clinical", "outside"] as const;

const nicRegex = /^([0-9]{9}[vVxX]|[0-9]{12})$/;
const nameRegex = /^[A-Za-z .'-]+$/;

export const userRoleSchema = z.enum(USER_ROLES);
export const genderSchema = z.enum(GENDERS);
export const appointmentStatusSchema = z.enum(APPOINTMENT_STATUSES);
export const prioritySchema = z.enum(PRIORITY_LEVELS);
export const drugSourceSchema = z.enum(DRUG_SOURCES);

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

const optionalDateString = z
  .string()
  .date()
  .optional()
  .nullable();

const dateOfBirthSchema = z
  .string()
  .date()
  .refine((value) => new Date(value) <= new Date(), "DOB cannot be in the future");

export const createPatientSchema = z.object({
  nic: z.string().regex(nicRegex, "Invalid NIC format").optional().nullable(),
  firstName: z.string().min(1).max(80).regex(nameRegex, "Invalid first name"),
  lastName: z.string().min(1).max(80).regex(nameRegex, "Invalid last name"),
  dob: dateOfBirthSchema.optional().nullable(),
  age: z.number().int().min(0).max(130).optional().nullable(),
  gender: genderSchema,
  phone: z.string().min(7).max(30).optional().nullable(),
  address: z.string().max(2000).optional().nullable(),
  bloodGroup: z.string().max(5).optional().nullable(),
  familyId: z.number().int().positive().optional().nullable()
});

export const updatePatientSchema = createPatientSchema.partial();

export const createFamilySchema = z.object({
  familyCode: z.string().max(30).optional(),
  familyName: z.string().min(1).max(120),
  assigned: z.boolean().optional()
});

export const createAppointmentSchema = z.object({
  patientId: z.number().int().positive(),
  doctorId: z.number().int().positive().optional().nullable(),
  assistantId: z.number().int().positive().optional().nullable(),
  scheduledAt: z.string().datetime(),
  status: appointmentStatusSchema.default("waiting"),
  reason: z.string().max(5000).optional().nullable(),
  priority: prioritySchema.default("normal")
});

const diagnosisInputSchema = z.object({
  icd10Code: z.string().max(16).optional().nullable(),
  diagnosisName: z.string().min(1).max(255)
});

const testOrderInputSchema = z.object({
  testName: z.string().min(1).max(180),
  status: z.enum(["ordered", "in_progress", "completed", "cancelled"]).default("ordered")
});

const prescriptionItemInputSchema = z.object({
  drugName: z.string().min(1).max(180),
  dose: z.string().min(1).max(80),
  frequency: z.string().min(1).max(80),
  duration: z.string().max(80).optional().nullable(),
  quantity: z.number().positive(),
  source: drugSourceSchema
});

export const createEncounterBundleSchema = z.object({
  appointmentId: z.number().int().positive(),
  patientId: z.number().int().positive(),
  doctorId: z.number().int().positive(),
  checkedAt: z.string().datetime(),
  notes: z.string().max(10000).optional().nullable(),
  nextVisitDate: optionalDateString,
  diagnoses: z.array(diagnosisInputSchema).default([]),
  tests: z.array(testOrderInputSchema).default([]),
  prescription: z
    .object({
      items: z.array(prescriptionItemInputSchema).min(1)
    })
    .optional()
}).refine((payload) => {
  if (!payload.prescription) {
    return true;
  }
  return payload.prescription.items.length > 0;
}, "If prescription exists, at least one complete drug row is required");

export const dispensePrescriptionSchema = z.object({
  prescriptionId: z.number().int().positive(),
  assistantId: z.number().int().positive(),
  dispensedAt: z.string().datetime(),
  status: z.enum(["completed", "partially_completed", "cancelled"]).default("completed"),
  notes: z.string().max(10000).optional().nullable(),
  items: z
    .array(
      z.object({
        inventoryItemId: z.number().int().positive(),
        quantity: z.number().positive()
      })
    )
    .min(1)
});

export const createInventoryItemSchema = z.object({
  sku: z.string().max(80).optional().nullable(),
  name: z.string().min(1).max(180),
  category: z.enum(["medicine", "consumable", "equipment", "other"]),
  unit: z.string().min(1).max(20),
  stock: z.number().nonnegative().default(0),
  reorderLevel: z.number().nonnegative().default(0),
  isActive: z.boolean().default(true)
});

export const createVitalSchema = z.object({
  patientId: z.number().int().positive(),
  encounterId: z.number().int().positive().optional().nullable(),
  bpSystolic: z.number().int().min(30).max(300).optional().nullable(),
  bpDiastolic: z.number().int().min(20).max(200).optional().nullable(),
  heartRate: z.number().int().min(20).max(300).optional().nullable(),
  temperatureC: z.number().min(25).max(45).optional().nullable(),
  spo2: z.number().int().min(0).max(100).optional().nullable(),
  recordedAt: z.string().datetime()
});

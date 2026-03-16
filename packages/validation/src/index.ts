import { z } from "zod";

const USER_ROLES = ["owner", "doctor", "assistant"] as const;
const GENDERS = ["male", "female", "other"] as const;
const PERMISSIONS = [
  "patient.read",
  "patient.write",
  "patient.delete",
  "patient.history.read",
  "patient.history.write",
  "patient.profile.read",
  "patient.family.read",
  "patient.allergy.read",
  "patient.allergy.write",
  "patient.condition.read",
  "patient.condition.write",
  "patient.vital.read",
  "patient.vital.write",
  "patient.timeline.read",
  "patient.timeline.write",
  "user.read",
  "user.write",
  "clinical.icd10.read",
  "appointment.read",
  "appointment.create",
  "appointment.update",
  "analytics.read",
  "audit.read",
  "encounter.read",
  "encounter.write",
  "family.read",
  "family.write",
  "inventory.read",
  "inventory.write",
  "prescription.read",
  "prescription.dispense"
] as const;
const APPOINTMENT_STATUSES = ["waiting", "in_consultation", "completed", "cancelled"] as const;
const PRIORITY_LEVELS = ["low", "normal", "high", "critical"] as const;
const DRUG_SOURCES = ["clinical", "outside"] as const;

const nicRegex = /^([0-9]{9}[vVxX]|[0-9]{12})$/;
const nameRegex = /^[A-Za-z .'-]+$/;
const patientNameSchema = z.string().trim().min(1).max(80).regex(nameRegex, "Invalid name");

export const userRoleSchema = z.enum(USER_ROLES);
export const genderSchema = z.enum(GENDERS);
export const permissionSchema = z.enum(PERMISSIONS);
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
  firstName: patientNameSchema,
  lastName: patientNameSchema,
  dob: dateOfBirthSchema,
  age: z.number().int().min(0).max(130).optional(),
  gender: genderSchema,
  phone: z.string().min(7).max(30).optional().nullable(),
  address: z.string().max(2000).optional().nullable(),
  bloodGroup: z.string().max(5).optional().nullable(),
  familyId: z.number().int().positive().optional().nullable()
});

export const updatePatientSchema = createPatientSchema.partial();

export const createPatientFrontendSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    nic: z.string().max(32).optional().nullable(),
    age: z.number().int().min(0).max(130).optional(),
    gender: genderSchema.optional(),
    mobile: z.string().trim().max(30).optional().nullable(),
    priority: prioritySchema.optional(),
    dateOfBirth: dateOfBirthSchema,
    phone: z.string().trim().max(30).optional().nullable(),
    address: z.string().trim().max(255).optional().nullable()
  })
  .strict();

export const updatePatientFrontendSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    nic: z.string().max(32).optional().nullable(),
    age: z.number().int().min(0).max(130).optional(),
    gender: genderSchema.optional().nullable(),
    mobile: z.string().trim().max(30).optional().nullable(),
    priority: prioritySchema.optional().nullable(),
    dateOfBirth: dateOfBirthSchema.optional(),
    phone: z.string().trim().max(30).optional().nullable(),
    address: z.string().trim().max(255).optional().nullable()
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.nic !== undefined ||
      value.age !== undefined ||
      value.gender !== undefined ||
      value.mobile !== undefined ||
      value.priority !== undefined ||
      value.dateOfBirth !== undefined ||
      value.phone !== undefined ||
      value.address !== undefined,
    "At least one field must be provided"
  );

export const createPatientHistorySchema = z.object({
  note: z.string().trim().min(1).max(1000)
}).strict();

export const authLoginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1),
    organizationId: z.string().uuid()
  })
  .strict();

export const refreshTokenSchema = z
  .object({
    refreshToken: z.string().min(20)
  })
  .strict();

export const clinicalIcd10QuerySchema = z
  .object({
    terms: z.string().trim().max(100).optional()
  })
  .strict();

export const createUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80).regex(nameRegex, "Invalid first name"),
  lastName: z.string().trim().min(1).max(80).regex(nameRegex, "Invalid last name"),
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(8).max(128),
  role: userRoleSchema,
  extraPermissions: z.array(permissionSchema).max(PERMISSIONS.length).optional()
});

export const createUserFrontendSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(160),
    password: z.string().min(8).max(128),
    role: userRoleSchema,
    extraPermissions: z.array(permissionSchema).max(PERMISSIONS.length).optional()
  })
  .strict();

export const updateUserSchema = z
  .object({
    extraPermissions: z.array(permissionSchema).max(PERMISSIONS.length).optional().nullable(),
    isActive: z.boolean().optional()
  })
  .strict()
  .refine(
    (value) => value.extraPermissions !== undefined || value.isActive !== undefined,
    "At least one field must be provided"
  );

export const listUsersQuerySchema = z.object({
  role: userRoleSchema.optional()
}).strict();

export const createFamilyMemberSchema = z
  .object({
    patientId: z.number().int().positive(),
    relationship: z.string().max(40).optional().nullable()
  })
  .strict();

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

export const listAppointmentsQuerySchema = z
  .object({
    status: appointmentStatusSchema.optional()
  })
  .strict();

export const searchPatientsQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(120),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(50).default(20)
  })
  .strict();

export const updateAppointmentSchema = z
  .object({
    status: appointmentStatusSchema.optional(),
    doctorId: z.number().int().positive().optional().nullable(),
    assistantId: z.number().int().positive().optional().nullable(),
    scheduledAt: z.string().datetime().optional(),
    reason: z.string().max(5000).optional().nullable(),
    priority: prioritySchema.optional()
  })
  .strict()
  .refine(
    (value) =>
      value.status !== undefined ||
      value.doctorId !== undefined ||
      value.assistantId !== undefined ||
      value.scheduledAt !== undefined ||
      value.reason !== undefined ||
      value.priority !== undefined,
    "At least one field must be provided"
  );

export const createPatientConditionSchema = z
  .object({
    conditionName: z.string().trim().min(1).max(180),
    icd10Code: z.string().max(16).optional().nullable(),
    status: z.string().trim().min(1).max(20).optional()
  })
  .strict();

export const createPatientAllergySchema = z
  .object({
    allergyName: z.string().trim().min(1).max(120),
    severity: z.enum(["low", "moderate", "high"]).optional().nullable(),
    isActive: z.boolean().optional()
  })
  .strict();

export const createPatientTimelineEventSchema = z
  .object({
    encounterId: z.number().int().positive().optional().nullable(),
    eventDate: z.string().date(),
    title: z.string().trim().min(1).max(160),
    description: z.string().optional().nullable(),
    eventKind: z.string().max(30).optional().nullable(),
    tags: z.array(z.string()).optional().nullable(),
    value: z.string().max(80).optional().nullable()
  })
  .strict();

const diagnosisInputSchema = z
  .object({
    icd10Code: z.string().max(16).optional().nullable(),
    diagnosisName: z.string().min(1).max(255)
  })
  .strict();

const testOrderInputSchema = z
  .object({
    testName: z.string().min(1).max(180),
    status: z.enum(["ordered", "in_progress", "completed", "cancelled"]).default("ordered")
  })
  .strict();

const prescriptionItemInputSchema = z
  .object({
    drugName: z.string().min(1).max(180),
    dose: z.string().min(1).max(80),
    frequency: z.string().min(1).max(80),
    duration: z.string().max(80).optional().nullable(),
    quantity: z.number().positive(),
    source: drugSourceSchema
  })
  .strict();

export const createEncounterBundleSchema = z
  .object({
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
      .strict()
      .optional()
  })
  .strict()
  .refine((payload) => {
    if (!payload.prescription) {
      return true;
    }
    return payload.prescription.items.length > 0;
  }, "If prescription exists, at least one complete drug row is required");

export const dispensePrescriptionSchema = z
  .object({
    prescriptionId: z.number().int().positive(),
    assistantId: z.number().int().positive(),
    dispensedAt: z.string().datetime(),
    status: z.enum(["completed", "partially_completed", "cancelled"]).default("completed"),
    notes: z.string().max(10000).optional().nullable(),
    items: z
      .array(
        z
          .object({
            inventoryItemId: z.number().int().positive(),
            quantity: z.number().positive()
          })
          .strict()
      )
      .min(1)
  })
  .strict();

export const createInventoryItemSchema = z.object({
  sku: z.string().max(80).optional().nullable(),
  name: z.string().min(1).max(180),
  category: z.enum(["medicine", "consumable", "equipment", "other"]),
  unit: z.string().min(1).max(20),
  stock: z.number().nonnegative().default(0),
  reorderLevel: z.number().nonnegative().default(0),
  isActive: z.boolean().default(true)
});

export const updateInventoryItemSchema = z
  .object({
    sku: z.string().max(80).optional().nullable(),
    name: z.string().min(1).max(180).optional(),
    category: z.enum(["medicine", "consumable", "equipment", "other"]).optional(),
    unit: z.string().min(1).max(20).optional(),
    reorderLevel: z.number().nonnegative().optional(),
    isActive: z.boolean().optional()
  })
  .strict()
  .refine(
    (value) =>
      value.sku !== undefined ||
      value.name !== undefined ||
      value.category !== undefined ||
      value.unit !== undefined ||
      value.reorderLevel !== undefined ||
      value.isActive !== undefined,
    "At least one field must be provided"
  );

export const createInventoryMovementSchema = z
  .object({
    movementType: z.enum(["in", "out", "adjustment"]),
    quantity: z.number().positive(),
    referenceType: z.string().max(60).optional().nullable(),
    referenceId: z.number().int().positive().optional().nullable()
  })
  .strict();

export const listAuditLogsQuerySchema = z
  .object({
    entityType: z.string().max(60).optional(),
    action: z.string().max(30).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().positive().max(1000).optional()
  })
  .strict();

export const createVitalSchema = z
  .object({
    patientId: z.number().int().positive(),
    encounterId: z.number().int().positive().optional().nullable(),
    bpSystolic: z.number().int().min(30).max(300).optional().nullable(),
    bpDiastolic: z.number().int().min(20).max(200).optional().nullable(),
    heartRate: z.number().int().min(20).max(300).optional().nullable(),
    temperatureC: z.number().min(25).max(45).optional().nullable(),
    spo2: z.number().int().min(0).max(100).optional().nullable(),
    recordedAt: z.string().datetime()
  })
  .strict();

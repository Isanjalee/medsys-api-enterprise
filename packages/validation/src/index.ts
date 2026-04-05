import { z } from "zod";

const USER_ROLES = ["owner", "doctor", "assistant"] as const;
const DOCTOR_WORKFLOW_MODES = ["self_service", "clinic_supported"] as const;
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
const CONSULTATION_WORKFLOW_TYPES = ["appointment", "walk_in"] as const;
const CONSULTATION_DISPENSE_MODES = ["assistant_queue", "doctor_direct"] as const;
const PRIORITY_LEVELS = ["low", "normal", "high", "critical"] as const;
const DRUG_SOURCES = ["clinical", "outside"] as const;

const nicRegex = /^([0-9]{9}[vVxX]|[0-9]{12})$/;
const nameRegex = /^[A-Za-z .'-]+$/;
const patientNameSchema = z.string().trim().min(1).max(80).regex(nameRegex, "Invalid name");
const guardianNameSchema = z.string().trim().min(1).max(120);
const guardianRelationshipSchema = z.string().trim().min(1).max(40);

export const userRoleSchema = z.enum(USER_ROLES);
export const doctorWorkflowModeSchema = z.enum(DOCTOR_WORKFLOW_MODES);
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

export const createPatientAllergySchema = z
  .object({
    allergyName: z.string().trim().min(1).max(120),
    severity: z.enum(["low", "moderate", "high"]).optional().nullable(),
    isActive: z.boolean().optional()
  })
  .strict();

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
  familyId: z.number().int().positive().optional().nullable(),
  familyCode: z.string().max(30).optional().nullable(),
  allergies: z.array(createPatientAllergySchema).optional().nullable(),
  guardianPatientId: z.number().int().positive().optional().nullable(),
  guardianName: guardianNameSchema.optional().nullable(),
  guardianNic: z.string().regex(nicRegex, "Invalid NIC format").optional().nullable(),
  guardianPhone: z.string().min(7).max(30).optional().nullable(),
  guardianRelationship: guardianRelationshipSchema.optional().nullable()
});

export const updatePatientSchema = createPatientSchema
  .partial()
  .refine(
    (value) =>
      value.nic !== undefined ||
      value.firstName !== undefined ||
      value.lastName !== undefined ||
      value.dob !== undefined ||
      value.age !== undefined ||
      value.gender !== undefined ||
      value.phone !== undefined ||
      value.address !== undefined ||
      value.bloodGroup !== undefined ||
      value.familyId !== undefined ||
      value.familyCode !== undefined ||
      value.allergies !== undefined ||
      value.guardianPatientId !== undefined ||
      value.guardianName !== undefined ||
      value.guardianNic !== undefined ||
      value.guardianPhone !== undefined ||
      value.guardianRelationship !== undefined,
    "At least one field must be provided"
  );

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
    address: z.string().trim().max(255).optional().nullable(),
    bloodGroup: z.string().max(5).optional().nullable(),
    familyCode: z.string().max(30).optional().nullable(),
    allergies: z.array(createPatientAllergySchema).optional().nullable(),
    familyId: z.number().int().positive().optional().nullable(),
    guardianPatientId: z.number().int().positive().optional().nullable(),
    guardianName: guardianNameSchema.optional().nullable(),
    guardianNic: z.string().regex(nicRegex, "Invalid NIC format").optional().nullable(),
    guardianPhone: z.string().min(7).max(30).optional().nullable(),
    guardianRelationship: guardianRelationshipSchema.optional().nullable()
  })
  .strict();

export const createGuardianFrontendSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    nic: z.string().max(32).optional().nullable(),
    age: z.number().int().min(0).max(130).optional(),
    gender: genderSchema.optional(),
    mobile: z.string().trim().max(30).optional().nullable(),
    dateOfBirth: dateOfBirthSchema,
    phone: z.string().trim().max(30).optional().nullable(),
    address: z.string().trim().max(255).optional().nullable(),
    bloodGroup: z.string().max(5).optional().nullable(),
    familyCode: z.string().max(30).optional().nullable(),
    familyId: z.number().int().positive().optional().nullable()
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
    address: z.string().trim().max(255).optional().nullable(),
    bloodGroup: z.string().max(5).optional().nullable(),
    familyCode: z.string().max(30).optional().nullable(),
    allergies: z.array(createPatientAllergySchema).optional().nullable(),
    familyId: z.number().int().positive().optional().nullable(),
    guardianPatientId: z.number().int().positive().optional().nullable(),
    guardianName: guardianNameSchema.optional().nullable(),
    guardianNic: z.string().regex(nicRegex, "Invalid NIC format").optional().nullable(),
    guardianPhone: z.string().min(7).max(30).optional().nullable(),
    guardianRelationship: guardianRelationshipSchema.optional().nullable()
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
      value.address !== undefined ||
      value.bloodGroup !== undefined ||
      value.familyCode !== undefined ||
      value.allergies !== undefined ||
      value.familyId !== undefined ||
      value.guardianPatientId !== undefined ||
      value.guardianName !== undefined ||
      value.guardianNic !== undefined ||
      value.guardianPhone !== undefined ||
      value.guardianRelationship !== undefined,
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

export const switchActiveRoleSchema = z
  .object({
    activeRole: userRoleSchema
  })
  .strict();

export const clinicalIcd10QuerySchema = z
  .object({
    terms: z.string().trim().max(100).optional()
  })
  .strict();

export const clinicalTerminologyQuerySchema = z
  .object({
    terms: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().positive().max(20).default(10)
  })
  .strict();

export const clinicalCodeParamSchema = z
  .object({
    code: z.string().trim().min(1).max(32)
  })
  .strict();

export const analyticsDashboardRoleSchema = z.enum(["doctor", "assistant", "owner"]);
export const analyticsDashboardRangeSchema = z.enum(["1d", "7d", "30d", "custom"]);

export const analyticsDashboardQuerySchema = z
  .object({
    range: analyticsDashboardRangeSchema.optional().default("7d"),
    role: analyticsDashboardRoleSchema.optional(),
    doctorId: z.coerce.number().int().positive().optional().nullable(),
    assistantId: z.coerce.number().int().positive().optional().nullable(),
    dateFrom: optionalDateString,
    dateTo: optionalDateString
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.range === "custom") {
      if (!value.dateFrom) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dateFrom"],
          message: "dateFrom is required when range=custom"
        });
      }
      if (!value.dateTo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dateTo"],
          message: "dateTo is required when range=custom"
        });
      }
    }

    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateFrom"],
        message: "dateFrom must be on or before dateTo"
      });
    }
  });

export const createUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80).regex(nameRegex, "Invalid first name"),
  lastName: z.string().trim().min(1).max(80).regex(nameRegex, "Invalid last name"),
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(8).max(128),
  role: userRoleSchema.optional(),
  roles: z.array(userRoleSchema).min(1).optional(),
  activeRole: userRoleSchema.optional().nullable(),
  doctorWorkflowMode: doctorWorkflowModeSchema.optional().nullable(),
  extraPermissions: z.array(permissionSchema).max(PERMISSIONS.length).optional()
}).superRefine((value, ctx) => {
  const roles = value.roles ?? (value.role ? [value.role] : []);

  if (roles.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["roles"],
      message: "Provide role or roles."
    });
    return;
  }

  if (value.activeRole && !roles.includes(value.activeRole)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activeRole"],
      message: "activeRole must be included in roles."
    });
  }

  if (roles.includes("doctor")) {
    return;
  }

  if (value.doctorWorkflowMode !== undefined && value.doctorWorkflowMode !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["doctorWorkflowMode"],
      message: "doctorWorkflowMode is only allowed for doctor users."
    });
  }
});

export const createUserFrontendSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(160),
    password: z.string().min(8).max(128),
    role: userRoleSchema.optional(),
    roles: z.array(userRoleSchema).min(1).optional(),
    activeRole: userRoleSchema.optional().nullable(),
    doctorWorkflowMode: doctorWorkflowModeSchema.optional().nullable(),
    extraPermissions: z.array(permissionSchema).max(PERMISSIONS.length).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const roles = value.roles ?? (value.role ? [value.role] : []);

    if (roles.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roles"],
        message: "Provide role or roles."
      });
      return;
    }

    if (value.activeRole && !roles.includes(value.activeRole)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeRole"],
        message: "activeRole must be included in roles."
      });
    }

    if (roles.includes("doctor")) {
      return;
    }

    if (value.doctorWorkflowMode !== undefined && value.doctorWorkflowMode !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["doctorWorkflowMode"],
        message: "doctorWorkflowMode is only allowed for doctor users."
      });
    }
  });

export const updateUserSchema = z
  .object({
    roles: z.array(userRoleSchema).min(1).optional().nullable(),
    activeRole: userRoleSchema.optional().nullable(),
    doctorWorkflowMode: doctorWorkflowModeSchema.optional().nullable(),
    extraPermissions: z.array(permissionSchema).max(PERMISSIONS.length).optional().nullable(),
    isActive: z.boolean().optional()
  })
  .strict()
  .refine(
    (value) =>
      value.roles !== undefined ||
      value.activeRole !== undefined ||
      value.doctorWorkflowMode !== undefined ||
      value.extraPermissions !== undefined ||
      value.isActive !== undefined,
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

export const startVisitSchema = z
  .object({
    patientId: z.number().int().positive(),
    doctorId: z.number().int().positive().optional().nullable(),
    assistantId: z.number().int().positive().optional().nullable(),
    scheduledAt: z.string().datetime().optional(),
    reason: z.string().max(5000).optional().nullable(),
    priority: prioritySchema.default("normal")
  })
  .strict();

export const listAppointmentsQuerySchema = z
  .object({
    status: appointmentStatusSchema.optional()
  })
  .strict();

export const patientVisibilityScopeSchema = z.enum(["organization", "my_patients"]);

export const listPatientsQuerySchema = z
  .object({
    scope: patientVisibilityScopeSchema.optional(),
    doctorId: z.coerce.number().int().positive().optional().nullable()
  })
  .strict();

export const searchPatientsQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(120),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(50).default(20),
    scope: patientVisibilityScopeSchema.optional(),
    doctorId: z.coerce.number().int().positive().optional().nullable()
  })
  .strict();

export const searchInventoryQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(120),
    limit: z.coerce.number().int().positive().max(20).default(10),
    category: z.enum(["medicine", "consumable", "equipment", "other"]).optional(),
    activeOnly: z.coerce.boolean().default(true)
  })
  .strict();

export const inventoryAlertsQuerySchema = z
  .object({
    days: z.coerce.number().int().min(7).max(180).default(30),
    category: z.enum(["medicine", "consumable", "equipment", "other"]).optional(),
    activeOnly: z.coerce.boolean().default(true)
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

const consultationDiagnosisInputSchema = diagnosisInputSchema
  .extend({
    persistAsCondition: z.boolean().optional()
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

const encounterVitalInputSchema = z
  .object({
    bpSystolic: z.number().int().min(30).max(300).optional().nullable(),
    bpDiastolic: z.number().int().min(20).max(200).optional().nullable(),
    heartRate: z.number().int().min(20).max(300).optional().nullable(),
    temperatureC: z.number().min(25).max(45).optional().nullable(),
    spo2: z.number().int().min(0).max(100).optional().nullable(),
    recordedAt: z.string().datetime().optional()
  })
  .strict()
  .refine(
    (value) =>
      value.bpSystolic !== undefined ||
      value.bpDiastolic !== undefined ||
      value.heartRate !== undefined ||
      value.temperatureC !== undefined ||
      value.spo2 !== undefined,
    "If vitals exist, at least one vital measurement must be provided"
  );

export const createEncounterBundleSchema = z
  .object({
    appointmentId: z.number().int().positive(),
    patientId: z.number().int().positive(),
    doctorId: z.number().int().positive(),
    checkedAt: z.string().datetime(),
    notes: z.string().max(10000).optional().nullable(),
    nextVisitDate: optionalDateString,
    vitals: encounterVitalInputSchema.optional(),
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

export const saveConsultationWorkflowSchema = z
  .object({
    workflowType: z.enum(CONSULTATION_WORKFLOW_TYPES).default("walk_in"),
    appointmentId: z.number().int().positive().optional(),
    patientId: z.number().int().positive().optional(),
    patientDraft: createPatientFrontendSchema.optional(),
    guardianDraft: createGuardianFrontendSchema.optional(),
    doctorId: z.number().int().positive().optional().nullable(),
    assistantId: z.number().int().positive().optional().nullable(),
    checkedAt: z.string().datetime(),
    scheduledAt: z.string().datetime().optional(),
    reason: z.string().max(5000).optional().nullable(),
    priority: prioritySchema.default("normal"),
    notes: z.string().max(10000).optional().nullable(),
    clinicalSummary: z.string().max(4000).optional().nullable(),
    nextVisitDate: optionalDateString,
    vitals: encounterVitalInputSchema.optional(),
    diagnoses: z.array(consultationDiagnosisInputSchema).default([]),
    tests: z.array(testOrderInputSchema).default([]),
    allergies: z.array(createPatientAllergySchema).default([]),
    prescription: z
      .object({
        items: z.array(prescriptionItemInputSchema).min(1)
      })
      .strict()
      .optional(),
    dispense: z
      .object({
        mode: z.enum(CONSULTATION_DISPENSE_MODES).default("assistant_queue"),
        dispensedAt: z.string().datetime().optional(),
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
          .optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.workflowType === "appointment") {
      if (!payload.appointmentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["appointmentId"],
          message: "appointmentId is required for appointment workflow."
        });
      }

      if (!payload.patientId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["patientId"],
          message: "patientId is required for appointment workflow."
        });
      }

      if (payload.patientDraft) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["patientDraft"],
          message: "patientDraft is not allowed for appointment workflow."
        });
      }

      if (payload.guardianDraft) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["guardianDraft"],
          message: "guardianDraft is not allowed for appointment workflow."
        });
      }
    }

    if (payload.workflowType === "walk_in" && !payload.patientId && !payload.patientDraft) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["patientDraft"],
        message: "Either patientId or patientDraft is required."
      });
    }

    if (payload.patientId && payload.patientDraft) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["patientId"],
        message: "Provide either patientId or patientDraft, not both."
      });
    }

    if (payload.workflowType === "walk_in" && payload.appointmentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appointmentId"],
        message: "appointmentId is not used for walk_in workflow."
      });
    }

    if (payload.prescription && payload.prescription.items.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prescription", "items"],
        message: "If prescription exists, at least one complete drug row is required."
      });
    }

    if (payload.dispense?.mode === "doctor_direct" && !payload.prescription) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dispense", "mode"],
        message: "doctor_direct dispense requires a prescription."
      });
    }

    if (payload.dispense?.mode === "doctor_direct" && !payload.dispense.items?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dispense", "items"],
        message: "doctor_direct dispense requires at least one inventory item."
      });
    }
  });

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
  genericName: z.string().min(1).max(180).optional().nullable(),
  category: z.enum(["medicine", "consumable", "equipment", "other"]),
  subcategory: z.string().min(1).max(80).optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
  dosageForm: z.string().min(1).max(40).optional().nullable(),
  strength: z.string().min(1).max(40).optional().nullable(),
  unit: z.string().min(1).max(20),
  dispenseUnit: z.string().min(1).max(20).optional().nullable(),
  dispenseUnitSize: z.number().positive().optional().nullable(),
  purchaseUnit: z.string().min(1).max(20).optional().nullable(),
  purchaseUnitSize: z.number().positive().optional().nullable(),
  route: z.string().min(1).max(40).optional().nullable(),
  prescriptionType: z.enum(["clinical", "outside", "both"]).optional().nullable(),
  packageUnit: z.string().min(1).max(20).optional().nullable(),
  packageSize: z.number().positive().optional().nullable(),
  brandName: z.string().min(1).max(120).optional().nullable(),
  supplierName: z.string().min(1).max(120).optional().nullable(),
  leadTimeDays: z.number().int().min(0).max(365).optional().nullable(),
  stock: z.number().nonnegative().default(0),
  reorderLevel: z.number().nonnegative().default(0),
  minStockLevel: z.number().nonnegative().optional().nullable(),
  maxStockLevel: z.number().nonnegative().optional().nullable(),
  expiryDate: optionalDateString,
  batchNo: z.string().min(1).max(80).optional().nullable(),
  storageLocation: z.string().min(1).max(120).optional().nullable(),
  directDispenseAllowed: z.boolean().optional().default(false),
  isAntibiotic: z.boolean().optional().default(false),
  isControlled: z.boolean().optional().default(false),
  isPediatricSafe: z.boolean().optional().default(false),
  requiresPrescription: z.boolean().optional().default(true),
  clinicUseOnly: z.boolean().optional().default(false),
  notes: z.string().max(4000).optional().nullable(),
  isActive: z.boolean().default(true)
});

export const updateInventoryItemSchema = z
  .object({
    sku: z.string().max(80).optional().nullable(),
    name: z.string().min(1).max(180).optional(),
    genericName: z.string().min(1).max(180).optional().nullable(),
    category: z.enum(["medicine", "consumable", "equipment", "other"]).optional(),
    subcategory: z.string().min(1).max(80).optional().nullable(),
    description: z.string().max(4000).optional().nullable(),
    dosageForm: z.string().min(1).max(40).optional().nullable(),
    strength: z.string().min(1).max(40).optional().nullable(),
    unit: z.string().min(1).max(20).optional(),
    dispenseUnit: z.string().min(1).max(20).optional().nullable(),
    dispenseUnitSize: z.number().positive().optional().nullable(),
    purchaseUnit: z.string().min(1).max(20).optional().nullable(),
    purchaseUnitSize: z.number().positive().optional().nullable(),
    route: z.string().min(1).max(40).optional().nullable(),
    prescriptionType: z.enum(["clinical", "outside", "both"]).optional().nullable(),
    packageUnit: z.string().min(1).max(20).optional().nullable(),
    packageSize: z.number().positive().optional().nullable(),
    brandName: z.string().min(1).max(120).optional().nullable(),
    supplierName: z.string().min(1).max(120).optional().nullable(),
    leadTimeDays: z.number().int().min(0).max(365).optional().nullable(),
    reorderLevel: z.number().nonnegative().optional(),
    minStockLevel: z.number().nonnegative().optional().nullable(),
    maxStockLevel: z.number().nonnegative().optional().nullable(),
    expiryDate: optionalDateString,
    batchNo: z.string().min(1).max(80).optional().nullable(),
    storageLocation: z.string().min(1).max(120).optional().nullable(),
    directDispenseAllowed: z.boolean().optional(),
    isAntibiotic: z.boolean().optional(),
    isControlled: z.boolean().optional(),
    isPediatricSafe: z.boolean().optional(),
    requiresPrescription: z.boolean().optional(),
    clinicUseOnly: z.boolean().optional(),
    notes: z.string().max(4000).optional().nullable(),
    isActive: z.boolean().optional()
  })
  .strict()
  .refine(
    (value) =>
      value.sku !== undefined ||
      value.name !== undefined ||
      value.genericName !== undefined ||
      value.category !== undefined ||
      value.subcategory !== undefined ||
      value.description !== undefined ||
      value.dosageForm !== undefined ||
      value.strength !== undefined ||
      value.unit !== undefined ||
      value.dispenseUnit !== undefined ||
      value.dispenseUnitSize !== undefined ||
      value.purchaseUnit !== undefined ||
      value.purchaseUnitSize !== undefined ||
      value.route !== undefined ||
      value.prescriptionType !== undefined ||
      value.packageUnit !== undefined ||
      value.packageSize !== undefined ||
      value.brandName !== undefined ||
      value.supplierName !== undefined ||
      value.leadTimeDays !== undefined ||
      value.reorderLevel !== undefined ||
      value.minStockLevel !== undefined ||
      value.maxStockLevel !== undefined ||
      value.expiryDate !== undefined ||
      value.batchNo !== undefined ||
      value.storageLocation !== undefined ||
      value.directDispenseAllowed !== undefined ||
      value.isAntibiotic !== undefined ||
      value.isControlled !== undefined ||
      value.isPediatricSafe !== undefined ||
      value.requiresPrescription !== undefined ||
      value.clinicUseOnly !== undefined ||
      value.notes !== undefined ||
      value.isActive !== undefined,
    "At least one field must be provided"
  );

export const createInventoryMovementSchema = z
  .object({
    movementType: z.enum(["in", "out", "adjustment"]),
    quantity: z.number().positive(),
    reason: z.enum(["purchase", "dispense", "damage", "expired", "return", "adjustment", "manual"]).optional().nullable(),
    note: z.string().max(2000).optional().nullable(),
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
  .strict()
  .refine(
    (value) =>
      value.bpSystolic !== undefined ||
      value.bpDiastolic !== undefined ||
      value.heartRate !== undefined ||
      value.temperatureC !== undefined ||
      value.spo2 !== undefined,
    "At least one vital measurement must be provided"
  );

export const updateVitalSchema = z
  .object({
    encounterId: z.number().int().positive().optional().nullable(),
    bpSystolic: z.number().int().min(30).max(300).optional().nullable(),
    bpDiastolic: z.number().int().min(20).max(200).optional().nullable(),
    heartRate: z.number().int().min(20).max(300).optional().nullable(),
    temperatureC: z.number().min(25).max(45).optional().nullable(),
    spo2: z.number().int().min(0).max(100).optional().nullable(),
    recordedAt: z.string().datetime().optional()
  })
  .strict()
  .refine(
    (value) =>
      value.encounterId !== undefined ||
      value.bpSystolic !== undefined ||
      value.bpDiastolic !== undefined ||
      value.heartRate !== undefined ||
      value.temperatureC !== undefined ||
      value.spo2 !== undefined ||
      value.recordedAt !== undefined,
    "At least one field must be provided"
  );

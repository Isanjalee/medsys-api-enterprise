# MEDSYS Create API Validation Matrix

Last updated: 2026-04-11
Scope: Backend create-style endpoints (`POST`) and auth bootstrap/login payload validation.

## Global validation behavior
- Unknown fields are rejected on most create endpoints (`strict` schemas).
- Numeric IDs are generally `int` + `positive`.
- `date` fields use `YYYY-MM-DD`.
- `datetime` fields use ISO-8601 timestamps.
- Backend also applies business-rule validation after schema checks (tenant scope, stock checks, permissions).

## 1) Auth

### POST `/v1/auth/resolve-organization`
Required:
- `organizationSlug` (string, 3-80, regex: lowercase letters, numbers, hyphens)

Optional:
- none

Example:
```json
{
  "organizationSlug": "sunrise-clinic"
}
```

### POST `/v1/auth/login-with-slug`
Required:
- `email` (valid email)
- `password` (string, min 1)
- `organizationSlug` (string, 3-80, slug regex)

Optional:
- `roleHint` (`owner` | `doctor` | `assistant` | `null`)

Example:
```json
{
  "email": "owner@sunrise.local",
  "password": "ownerSun@123",
  "organizationSlug": "sunrise-clinic",
  "roleHint": "owner"
}
```

### POST `/v1/auth/login`
Required:
- `email` (valid email)
- `password` (string, min 1)
- `organizationId` (UUID)

Optional:
- `roleHint` (`owner` | `doctor` | `assistant` | `null`)

Example:
```json
{
  "email": "owner@sunrise.local",
  "password": "ownerSun@123",
  "organizationId": "742a1bcf-c8fd-49b3-b729-3c6d67c19979",
  "roleHint": "owner"
}
```

### POST `/v1/auth/bootstrap-organization`
Required:
- `organizationName` (string, 2-160)
- `organizationSlug` (string, 3-80, slug regex)
- `ownerName` (string, 2-120)
- `ownerEmail` (email, max 160)
- `password` (string, 8-128)

Optional:
- none

Example:
```json
{
  "organizationName": "Sunrise Clinic",
  "organizationSlug": "sunrise-clinic",
  "ownerName": "Clinic Owner",
  "ownerEmail": "owner@sunrise.local",
  "password": "ownerSun@123"
}
```

### POST `/v1/auth/register`
Frontend-style required:
- `name`, `email`, `password`, and either `role` or `roles`

Backend-style required:
- `firstName`, `lastName`, `email`, `password`, and either `role` or `roles`

Optional:
- `activeRole`
- `doctorWorkflowMode` (`self_service` | `clinic_supported` | `null`)
- `extraPermissions` (allowed permission enum only)

Cross-field validation:
- `activeRole` must be included in resolved roles.
- `doctorWorkflowMode` allowed only when roles include `doctor`.

Frontend example:
```json
{
  "name": "System Owner",
  "email": "owner@example.com",
  "password": "owner-pass-123",
  "roles": ["owner"],
  "activeRole": "owner"
}
```

Backend example:
```json
{
  "firstName": "Support",
  "lastName": "Doctor",
  "email": "doctor-support@example.com",
  "password": "doctor-pass-123",
  "roles": ["owner", "doctor"],
  "activeRole": "doctor",
  "doctorWorkflowMode": "clinic_supported",
  "extraPermissions": ["inventory.write"]
}
```

### POST `/v1/auth/active-role`
Required:
- `activeRole` (`owner` | `doctor` | `assistant`)

Optional:
- none

Example:
```json
{
  "activeRole": "doctor"
}
```

## 2) Users

### POST `/v1/users`
Validation model is same as `POST /v1/auth/register` create-user payloads.

Example:
```json
{
  "firstName": "Assistant",
  "lastName": "User",
  "email": "assistant@example.com",
  "password": "assistant-pass-123",
  "roles": ["assistant"],
  "activeRole": "assistant"
}
```

## 3) Patients

### POST `/v1/patients` (frontend payload style)
Required:
- `name` (1-120)
- `dateOfBirth` (date; cannot be future)

Optional:
- `nic`, `age`, `gender`, `mobile`, `priority`, `phone`, `address`, `bloodGroup`
- `familyCode`, `familyId`
- `allergies[]`
- guardian fields: `guardianPatientId`, `guardianName`, `guardianNic`, `guardianPhone`, `guardianRelationship`

Example:
```json
{
  "name": "Nimal Perera",
  "dateOfBirth": "1992-08-15",
  "gender": "male",
  "mobile": "0771234567",
  "allergies": [
    {
      "allergyName": "Penicillin",
      "severity": "high",
      "isActive": true
    }
  ]
}
```

### POST `/v1/patients` (backend payload style)
Required:
- `firstName`, `lastName`
- `dob` (date; cannot be future)
- `gender`

Optional:
- `nic`, `age`, `phone`, `address`, `bloodGroup`
- family and guardian fields
- `allergies[]`

Example:
```json
{
  "firstName": "Nimal",
  "lastName": "Perera",
  "dob": "1992-08-15",
  "gender": "male",
  "phone": "0771234567"
}
```

### POST `/v1/patients/:id/history`
Required:
- `note` (1-1000)

Optional:
- none

Example:
```json
{
  "note": "Patient reported intermittent headache for 3 days."
}
```

### POST `/v1/patients/:id/conditions`
Required:
- `conditionName` (1-180)

Optional:
- `icd10Code` (max 16)
- `status` (1-20)

Example:
```json
{
  "conditionName": "Hypertension",
  "icd10Code": "I10",
  "status": "active"
}
```

### POST `/v1/patients/:id/allergies`
Required:
- `allergyName` (1-120)

Optional:
- `severity` (`low` | `moderate` | `high` | `null`)
- `isActive` (boolean)

Example:
```json
{
  "allergyName": "Ibuprofen",
  "severity": "moderate",
  "isActive": true
}
```

### POST `/v1/patients/:id/vitals`
Required:
- `recordedAt` (datetime)
- At least one of: `bpSystolic`, `bpDiastolic`, `heartRate`, `temperatureC`, `spo2`

Optional:
- `encounterId`

Ranges:
- `bpSystolic`: 30-300
- `bpDiastolic`: 20-200
- `heartRate`: 20-300
- `temperatureC`: 25-45
- `spo2`: 0-100

Example:
```json
{
  "recordedAt": "2026-04-11T09:10:00Z",
  "bpSystolic": 120,
  "bpDiastolic": 80,
  "heartRate": 78,
  "spo2": 98
}
```

### POST `/v1/patients/:id/timeline`
Required:
- `eventDate` (date)
- `title` (1-160)

Optional:
- `encounterId`
- `description`
- `eventKind` (max 30)
- `tags` (array of strings)
- `value` (max 80)

Example:
```json
{
  "eventDate": "2026-04-11",
  "title": "Follow-up advised",
  "description": "Review after 2 weeks with repeat CBC.",
  "eventKind": "follow_up"
}
```

## 4) Families

### POST `/v1/families`
Required:
- `familyName` (1-120)

Optional:
- `familyCode` (max 30)
- `assigned` (boolean)

Example:
```json
{
  "familyName": "Perera Family",
  "familyCode": "FAM-1001"
}
```

### POST `/v1/families/:id/members`
Required:
- `patientId` (positive int)

Optional:
- `relationship` (max 40)

Example:
```json
{
  "patientId": 42,
  "relationship": "son"
}
```

## 5) Appointments, Visits, Encounters, Consultations

### POST `/v1/appointments`
Required:
- `patientId`
- `scheduledAt` (datetime)

Optional:
- `doctorId`, `assistantId`
- `status` (`waiting` | `in_consultation` | `completed` | `cancelled`) default `waiting`
- `reason` (max 5000)
- `priority` (`low` | `normal` | `high` | `critical`) default `normal`

Example:
```json
{
  "patientId": 42,
  "scheduledAt": "2026-04-12T10:00:00Z",
  "reason": "Follow-up visit",
  "priority": "normal"
}
```

### POST `/v1/visits/start`
Required:
- `patientId`

Optional:
- `doctorId`, `assistantId`
- `scheduledAt` (datetime)
- `reason` (max 5000)
- `priority` (default `normal`)

Example:
```json
{
  "patientId": 42,
  "doctorId": 7,
  "reason": "Walk-in fever case"
}
```

### POST `/v1/encounters`
Required:
- `appointmentId`, `patientId`, `doctorId`, `checkedAt`

Optional:
- `notes`, `nextVisitDate`
- `vitals` block
- `diagnoses[]`
- `tests[]`
- `prescription.items[]`

Cross-field:
- If `prescription` exists, it must include at least 1 item.

Example:
```json
{
  "appointmentId": 101,
  "patientId": 42,
  "doctorId": 7,
  "checkedAt": "2026-04-11T10:15:00Z",
  "diagnoses": [
    { "diagnosisName": "Acute viral fever", "icd10Code": "B34.9" }
  ],
  "prescription": {
    "items": [
      {
        "drugName": "Paracetamol",
        "dose": "500mg",
        "frequency": "TID",
        "duration": "3 days",
        "quantity": 9,
        "source": "clinical"
      }
    ]
  }
}
```

### POST `/v1/consultations/save`
Required:
- `checkedAt`
- `workflowType` defaults to `walk_in`
- Conditional workflow rules apply

Optional:
- `appointmentId`, `patientId`, `patientDraft`, `guardianDraft`
- `doctorId`, `assistantId`, `scheduledAt`, `reason`, `priority`, `notes`, `clinicalSummary`, `nextVisitDate`
- `vitals`, `diagnoses`, `tests`, `allergies`, `prescription`, `dispense`

Critical cross-field rules:
- `workflowType=appointment` requires `appointmentId` and `patientId`.
- `workflowType=appointment` forbids `patientDraft` and `guardianDraft`.
- `workflowType=walk_in` requires either `patientId` or `patientDraft`.
- Do not send both `patientId` and `patientDraft`.
- `workflowType=walk_in` should not include `appointmentId`.
- `dispense.mode=doctor_direct` requires a prescription and at least one dispense item.

Walk-in example:
```json
{
  "workflowType": "walk_in",
  "checkedAt": "2026-04-11T10:30:00Z",
  "doctorId": 7,
  "patientDraft": {
    "name": "Kamal Silva",
    "dateOfBirth": "2001-02-10",
    "gender": "male",
    "mobile": "0770000000"
  },
  "diagnoses": [
    { "diagnosisName": "Acute pharyngitis", "icd10Code": "J02.9" }
  ]
}
```

## 6) Prescriptions

### POST `/v1/prescriptions/:id/dispense`
Required:
- `prescriptionId`
- `assistantId`
- `dispensedAt` (datetime)
- `items[]` (min 1) each with:
  - `inventoryItemId` (positive int)
  - `quantity` (positive number)

Optional:
- `status` (`completed` | `partially_completed` | `cancelled`) default `completed`
- `notes`

Example:
```json
{
  "prescriptionId": 333,
  "assistantId": 11,
  "dispensedAt": "2026-04-11T11:00:00Z",
  "status": "completed",
  "items": [
    { "inventoryItemId": 1, "quantity": 2 }
  ]
}
```

## 7) Inventory

### POST `/v1/inventory`
Required:
- `name` (1-180)
- `category` (`medicine` | `consumable` | `equipment` | `other`)
- `unit` (1-20)

Optional:
- all metadata fields (SKU, genericName, dosage, route, stock/reorder, supplier, etc.)

Defaults:
- `stock=0`, `reorderLevel=0`
- multiple booleans default to `false`
- `requiresPrescription=true`
- `isActive=true`

Example:
```json
{
  "name": "Paracetamol 500mg",
  "category": "medicine",
  "unit": "tablet",
  "stock": 100,
  "reorderLevel": 20,
  "dispenseUnit": "card",
  "dispenseUnitSize": 10
}
```

### POST `/v1/inventory/:id/movements`
Required:
- `movementType` (`in` | `out` | `adjustment`)
- `quantity` (positive)

Optional:
- `movementUnit`, `batchId`, `reason`, `note`, `referenceType`, `referenceId`

Business validation:
- `movementUnit` must match configured unit conversion for that item.
- Stock/batch availability checks may return conflict errors.

Example:
```json
{
  "movementType": "in",
  "quantity": 10,
  "movementUnit": "box",
  "reason": "purchase"
}
```

### POST `/v1/inventory/:id/adjust-stock`
Required:
- `actualStock` (nonnegative)

Optional:
- `note` (max 2000)

Example:
```json
{
  "actualStock": 75,
  "note": "Cycle count adjustment"
}
```

### POST `/v1/inventory/:id/batches`
Required:
- `batchNo` (1-80)
- `quantity` (positive)

Optional:
- `expiryDate`, `supplierName`, `storageLocation`, `receivedAt`, `note`

Example:
```json
{
  "batchNo": "BATCH-2026-04-11-A",
  "quantity": 120,
  "expiryDate": "2027-04-01",
  "supplierName": "ABC Pharma"
}
```

## 8) Tasks

### POST `/v1/tasks`
Required:
- `title` (1-180)
- `taskType` (1-40)
- `sourceType` (`appointment` | `consultation` | `prescription` | `dispense` | `inventory_alert` | `followup`)
- `assignedRole` (`owner` | `doctor` | `assistant`)

Optional:
- `description`, `sourceId`, `assignedUserId`
- `priority` default `normal`
- `status` default `pending`
- `visitMode`, `doctorWorkflowMode`, `dueAt`, `metadata`

Example:
```json
{
  "title": "Review delayed follow-up",
  "taskType": "followup_review",
  "sourceType": "followup",
  "sourceId": 88,
  "assignedRole": "doctor",
  "priority": "high"
}
```

### POST `/v1/tasks/:id/complete`
Required:
- none

Optional:
- `note` (max 2000)

Example:
```json
{
  "note": "Completed after patient callback."
}
```

## 9) Followups

### POST `/v1/followups`
Required:
- `patientId`
- `followupType` (1-40)
- `dueDate` (date)

Optional:
- `encounterId`, `doctorId`, `status`, `visitMode`, `doctorWorkflowMode`, `note`

Example:
```json
{
  "patientId": 42,
  "encounterId": 501,
  "doctorId": 7,
  "followupType": "clinical_review",
  "dueDate": "2026-04-25",
  "status": "pending",
  "doctorWorkflowMode": "clinic_supported"
}
```

## Notes for FE/BFF teams
- Keep endpoint payloads exact; avoid sending unknown keys to strict routes.
- Prefer slug-based tenant auth (`/auth/login-with-slug`) to avoid org UUID mismatch.
- For inventory movement, fetch item detail first and use a valid `movementUnit` configured on that item.
- For consultation save, enforce workflow guards on client side before submit to reduce validation round-trips.

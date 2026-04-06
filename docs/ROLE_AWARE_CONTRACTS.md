# Role-Aware Contracts

This note captures the role-aware backend contracts introduced during the identity migration.

## Auth Identity

Authenticated user responses now support multi-role identity with explicit workflow context:

```json
{
  "id": 42,
  "user_id": 42,
  "role": "doctor",
  "roles": ["owner", "doctor"],
  "active_role": "doctor",
  "doctor_workflow_mode": "self_service",
  "workflow_profiles": {
    "doctor": { "mode": "self_service" },
    "assistant": null,
    "owner": { "mode": "standard" }
  },
  "permissions": ["user.write", "appointment.create"],
  "extra_permissions": []
}
```

Compatibility notes:

- `role` remains aligned with `active_role` for existing clients.
- `doctor_workflow_mode` remains available for existing doctor-facing clients.
- `workflow_profiles` is the forward-looking source of workflow identity.

## Active Role Switching

Authenticated users can switch workspace context through:

`POST /v1/auth/active-role`

```json
{
  "activeRole": "owner"
}
```

Rules:

- the requested `activeRole` must already be assigned to the user
- the API persists the selection in `users.active_role`
- the response returns the updated serialized user payload

## Analytics Overview

`GET /v1/analytics/overview` keeps the existing top-level counters and now adds role context:

```json
{
  "patients": 120,
  "waitingAppointments": 8,
  "prescriptions": 64,
  "lowStockItems": 3,
  "role_context": {
    "role": "doctor",
    "active_role": "doctor",
    "roles": ["owner", "doctor"],
    "workflow_profile": {
      "mode": "self_service"
    }
  }
}
```

Frontend guidance:

- use the counter fields as before
- use `role_context` to decide role-specific dashboard framing, labels, and navigation
- do not infer workflow from permissions alone

## Analytics Dashboard

`GET /v1/analytics/dashboard` is the richer dashboard contract for doctor, assistant, and owner workspaces.

Query parameters:

- `range=1d|7d|30d|custom`
- `role=doctor|assistant|owner`
- `doctorId`
- `assistantId`
- `dateFrom`
- `dateTo`

Rules:

- doctors can call the endpoint without `role` or `doctorId`; backend defaults to their own doctor context
- assistants can call the endpoint without `role` or `assistantId`; backend defaults to their own assistant context
- owners can request owner, doctor, or assistant dashboards and may pass `doctorId` or `assistantId`
- `range=custom` requires both `dateFrom` and `dateTo`

Response shape:

```json
{
  "roleContext": {
    "resolvedRole": "doctor",
    "actorRole": "doctor",
    "activeRole": "doctor",
    "roles": ["doctor"],
    "doctorId": 12,
    "assistantId": null,
    "workflowProfile": {
      "mode": "self_service"
    }
  },
  "generatedAt": "2026-04-03T12:00:00.000Z",
  "range": {
    "preset": "7d",
    "dateFrom": "2026-03-27T12:00:00.000Z",
    "dateTo": "2026-04-03T12:00:00.000Z"
  },
  "summary": {},
  "charts": {},
  "insights": [],
  "tables": {},
  "alerts": []
}
```

Frontend guidance:

- treat `summary`, `charts`, `tables`, `insights`, and `alerts` as role-specific blocks rather than one universal dashboard layout
- render cards and charts defensively; field names inside those blocks differ by role
- use `roleContext.resolvedRole` as the source of truth for which dashboard variant is being rendered
- use `generatedAt` and `range` for page headers, caching labels, and export headers

### Doctor Dashboard Blocks

Current `summary` sections:

- `queue`
- `visits`
- `patientMix`
- `clinical`
- `prescribing`

Current `charts` keys:

- `patientVolumeByHour`
- `walkInVsAppointment`
- `queueFunnel`
- `waitTimeBuckets`
- `newVsReturning`
- `ageGroups`
- `genderSplit`
- `linkageSplit`
- `topDiagnoses`
- `topTests`
- `topMedications`
- `encounterCompleteness`
- `prescriptionSourceSplit`
- `topDispensedMedicines`
- `lowStockRelevantMedicines`
- `prescriptionsByDay`

### Assistant Dashboard Blocks

Current `summary` sections:

- `intake`
- `queue`
- `dispense`

Current `charts` keys:

- `registrationsByHour`
- `appointmentsByDoctor`
- `queueStatusSplit`
- `dispenseStatusSplit`
- `dailyIntakeTrend`

### Owner Dashboard Blocks

Current `summary` sections:

- `organizationGrowth`
- `operationalPerformance`
- `quality`
- `inventory`

Current `charts` keys:

- `growthTrend`
- `doctorWorkloadComparison`
- `assistantThroughputComparison`
- `appointmentStatusDistribution`
- `busyHours`
- `lowStockAndTopConsumed`
- `completionQualityAcrossRoles`

## Workflow Timing Fields

Exact workflow timing fields are now part of the backend data model for more accurate analytics:

- `appointments.registered_at`
- `appointments.waiting_at`
- `appointments.in_consultation_at`
- `appointments.completed_at`
- `encounters.closed_at`

Semantic guidance:

- `registered_at`: when the appointment or walk-in visit record was first created
- `waiting_at`: when the visit entered waiting status
- `in_consultation_at`: when the visit entered doctor consultation
- `completed_at`: when the appointment/visit was marked completed
- `closed_at`: when the encounter was clinically closed

Frontend guidance:

- prefer these fields over `created_at` and `updated_at` when showing queue or duration analytics
- treat older records as best-effort historical backfill rather than perfect event history

## Inventory Contract

Inventory now follows a base-unit plus packaging-conversion model.

Core rules:

- `unit` is the base stock unit and is the only unit used for stored `stock`, `reorderLevel`, `minStockLevel`, and `maxStockLevel`
- `dispenseUnit` and `dispenseUnitSize` describe the normal clinic-side dispense pack
- `purchaseUnit` and `purchaseUnitSize` describe the normal supplier-side purchase pack
- stock quantity changes should go through `POST /v1/inventory/:id/movements`, not `PATCH /v1/inventory/:id`

Example:

```json
{
  "unit": "tablet",
  "dispenseUnit": "card",
  "dispenseUnitSize": "10",
  "purchaseUnit": "box",
  "purchaseUnitSize": "100",
  "stock": "1000"
}
```

Meaning:

- stock is `1000 tablets`
- equivalent to `100 cards`
- equivalent to `10 boxes`

Frontend guidance:

- doctors and assistants should update stock through stock movements such as stock-in, stock-out, or adjustment
- edit-item forms should be used for descriptive fields, thresholds, and packaging rules
- `reorderLevel` is the low-stock trigger, not the quantity to add
- use `stockStatus` from backend for badges: `in_stock`, `low_stock`, `out_of_stock`, `near_expiry`, `expired`

Inventory endpoints now important for frontend:

- `GET /v1/inventory`
- `GET /v1/inventory/:id`
- `GET /v1/inventory/search`
- `GET /v1/inventory/alerts`
- `GET /v1/inventory/reports`
- `PATCH /v1/inventory/:id`
- `POST /v1/inventory/:id/movements`
- `POST /v1/inventory/:id/adjust-stock`
- `GET /v1/inventory/:id/batches`
- `POST /v1/inventory/:id/batches`

Additional inventory guidance:

- `POST /v1/inventory/:id/movements` now accepts optional `movementUnit` and returns `movement`, `item`, and `conversion`
- frontend can send `movementUnit` using the configured base, dispense, or purchase unit and let backend convert to base stock
- `POST /v1/inventory/:id/adjust-stock` is the correct endpoint for “actual counted stock is X”
- list and detail item payloads now include `stockSummary` with `currentStock`, `minimumStock`, `shortageToMinimum`, `isBelowMinimum`, `dispensePackEquivalent`, and `purchasePackEquivalent`
- `GET /v1/inventory/reports` returns supplier summary, movement velocity buckets, and expiring batches for owner and assistant operations
- `GET /v1/inventory/:id/batches` and `POST /v1/inventory/:id/batches` provide batch-level stock, expiry, supplier, and storage tracking

## Future AI Contract

This repo does not yet expose an AI API. When it does, the backend contract should be role-aware from day one:

```json
{
  "role_context": {
    "active_role": "doctor",
    "roles": ["owner", "doctor"],
    "workflow_profile": {
      "mode": "self_service"
    }
  }
}
```

Expected behavior:

- owner AI focuses on operations, staffing, and compliance
- doctor AI focuses on clinical workflow support
- assistant AI focuses on intake, queueing, and dispense coordination

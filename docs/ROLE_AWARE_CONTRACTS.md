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

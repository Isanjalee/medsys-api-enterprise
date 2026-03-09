# Frontend-Backend Contract Mapping

Current implementation mapping between:

- Frontend internal BFF contract: `/api/...`
- Backend domain API: `/v1/...`

Date: March 9, 2026
Status: Working integration mapping for implementation

## 1. Purpose

This document defines how the current frontend contract should map to the current backend API without forcing an immediate backend rewrite.

The intended near-term architecture is:

- Next.js `/api/...` remains the compatibility layer
- Fastify `/v1/...` remains the domain API
- request and response normalization happens in the BFF layer unless explicitly moved into the backend later

## 2. Mapping Rules

### 2.1 Request validation ownership

- Frontend `/api/...` validates incoming payloads exactly as documented in the frontend contract.
- Backend `/v1/...` continues to enforce its own schema and business validation.
- The BFF layer is responsible for translating frontend-safe payloads into backend payloads.

### 2.2 Response normalization ownership

- Backend responses should not be exposed to the browser unchanged when the frontend contract expects a different shape.
- The BFF layer must normalize backend responses into the contract documented by the frontend team.

### 2.3 Error normalization ownership

- Backend may continue returning `{ message, requestId }`.
- The BFF layer should translate validation and compatibility failures into the frontend envelope:

```json
{
  "error": "Validation failed.",
  "issues": [
    {
      "field": "name",
      "message": "Is required."
    }
  ]
}
```

## 3. Auth Route Mapping

### 3.1 `POST /api/auth/login`

Frontend request:

```json
{
  "email": "doctor@example.com",
  "password": "secret-123",
  "roleHint": "doctor",
  "organizationId": "11111111-1111-1111-1111-111111111111"
}
```

Backend target:

- `POST /v1/auth/login`

Backend request:

```json
{
  "email": "doctor@example.com",
  "password": "secret-123",
  "organizationId": "11111111-1111-1111-1111-111111111111"
}
```

Current mapping:

- pass `email`, `password`, `organizationId` through directly
- ignore `roleHint` for backend auth
- store returned backend tokens in secure HTTP-only cookies at the BFF layer

Current backend response:

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresIn": 900
}
```

Frontend response requirement:

```json
{
  "id": 42,
  "name": "Dr. Jane Doe",
  "email": "doctor@example.com",
  "role": "doctor"
}
```

Required BFF behavior:

- call backend login
- validate backend token payload structure
- decode or resolve the authenticated user profile
- return frontend session profile shape

Current blocker:

- backend login does not return user profile fields
- frontend `me` profile source is not defined yet

Recommended implementation:

- add backend `GET /v1/auth/me`
- keep login token issuance unchanged
- after login, BFF fetches `/v1/auth/me` and returns normalized session data

### 3.2 `POST /api/auth/logout`

Frontend behavior:

- clear backend auth cookies
- clear signed frontend session cookie

Backend mapping:

- no backend route required for minimum behavior

Recommended implementation:

- BFF-only route
- optional future backend token revocation endpoint if refresh-token revocation is made explicit

### 3.3 `GET /api/auth/me`

Frontend response:

```json
{
  "id": 42,
  "name": "Dr. Jane Doe",
  "email": "doctor@example.com",
  "role": "doctor"
}
```

Backend mapping:

- implemented as `GET /v1/auth/me`

Recommended backend response:

```json
{
  "id": 42,
  "name": "Dr. Jane Doe",
  "email": "doctor@example.com",
  "role": "doctor",
  "organizationId": "11111111-1111-1111-1111-111111111111"
}
```

BFF normalization:

- `name` can pass through directly if backend returns combined display name

### 3.4 `GET /api/auth/status`

Frontend response:

```json
{
  "bootstrapping": false,
  "users": 3
}
```

Backend mapping:

- implemented as `GET /v1/auth/status`

Recommended backend behavior:

- return whether this organization or installation has zero users
- return current user count visible for bootstrap logic

### 3.5 `POST /api/auth/register`

Frontend contract:

- first-user bootstrap can self-register as `owner`
- after bootstrap, registration requires `user.write`

Backend mapping:

- implemented as `POST /v1/auth/register`

Implemented behavior:

- if no users exist for the organization, allow owner bootstrap
- otherwise require authenticated actor with owner role

## 4. Backend Proxy Mapping

### 4.1 `/api/backend/:path*`

This is a BFF transport route, not a domain endpoint.

Responsibilities:

- inject bearer token from secure cookie
- forward only allowed headers
- call backend `/v1/...`
- refresh once on backend `401`
- clear cookies on refresh failure

No backend changes are required for the proxy itself.

## 5. Patient Route Mapping

## 5.1 `GET /api/patients`

Frontend response:

```json
{
  "patients": [
    {
      "id": 7,
      "name": "Jane Doe",
      "date_of_birth": "1990-06-01",
      "phone": "555-2222",
      "address": "42 Main Street",
      "created_at": "2026-03-09T00:00:00.000Z"
    }
  ]
}
```

Backend source:

- `GET /v1/patients`

Current backend response shape:

- raw array
- fields include `firstName`, `lastName`, `fullName`, `dob`, `phone`, `address`, `createdAt`

Required BFF mapping:

- wrap array in `{ patients: [...] }`
- `name` <- `fullName`
- `date_of_birth` <- `dob`
- `created_at` <- `createdAt`

No backend change is required for basic list support if the BFF layer performs mapping.

## 5.2 `POST /api/patients`

Frontend request:

```json
{
  "name": "Jane Doe",
  "dateOfBirth": "1990-06-01",
  "phone": "555-2222",
  "address": "42 Main Street"
}
```

Backend target:

- `POST /v1/patients`

Current backend requirement:

```json
{
  "firstName": "Jane",
  "lastName": "Doe",
  "gender": "female"
}
```

Current blocker:

- frontend does not supply `gender`
- frontend sends only a single `name`

Required decision:

- either expand the frontend create form to capture `firstName`, `lastName`, and `gender`
- or extend backend with a compatibility create contract

Recommended implementation:

- do not guess `gender`
- do not split `name` with brittle heuristics in production logic
- add a backend-compatible patient create endpoint or update the frontend contract

Interim fallback if business approves:

- BFF splits `name` into first token and remaining tokens
- BFF sends `gender: "other"`

This fallback is operationally weak and should be treated as temporary only.

## 5.3 `GET /api/patients/:id`

Frontend response:

```json
{
  "patient": {
    "id": 7,
    "name": "Jane Doe",
    "date_of_birth": null,
    "phone": null,
    "address": null,
    "created_at": "2026-03-09T00:00:00.000Z"
  },
  "history": []
}
```

Backend source candidates:

- `GET /v1/patients/:id`
- `GET /v1/patients/:id/timeline`

Recommended mapping:

- `patient` <- normalized `/v1/patients/:id`
- `history` <- currently unresolved

Current blocker:

- frontend `history` is simple note history
- backend timeline is broader and not equivalent

Required decision:

- create a new patient history resource
- or explicitly redefine frontend `history` to use timeline events

Recommended implementation:

- treat patient history as a new backend resource
- do not silently alias timeline to history unless the product owner approves the semantic change

## 5.4 `PATCH /api/patients/:id`

Frontend request keys:

- `name`
- `dateOfBirth`
- `phone`
- `address`

Backend target:

- `PATCH /v1/patients/:id`

Mapping:

- `dateOfBirth` -> `dob`
- `phone` -> `phone`
- `address` -> `address`
- `name` requires `firstName` and `lastName` translation

Current blocker:

- same naming issue as patient create

Recommended implementation:

- if only `name` is provided, BFF must split it before calling backend
- longer-term fix is to align frontend and backend patient name fields explicitly

## 5.5 `DELETE /api/patients/:id`

Frontend response:

```json
{
  "success": true
}
```

Backend mapping:

- implemented as `DELETE /v1/patients/:id`

Recommended behavior:

- soft delete via `deletedAt`
- preserve audit trail
- exclude deleted patients from standard reads

## 5.6 `GET /api/patients/:id/history`

Backend mapping:

- implemented as `GET /v1/patients/:id/history`

Recommended response:

```json
{
  "history": [
    {
      "id": 3,
      "note": "Observed for 24 hours",
      "created_at": "2026-03-09T00:00:00.000Z",
      "created_by_user_id": 1,
      "created_by_name": "Doctor User",
      "created_by_role": "doctor"
    }
  ]
}
```

## 5.7 `POST /api/patients/:id/history`

Backend mapping:

- implemented as `POST /v1/patients/:id/history`

Recommended write model:

```json
{
  "note": "Observed for 24 hours"
}
```

Implemented storage fields:

- `id`
- `organization_id`
- `patient_id`
- `note`
- `created_by_user_id`
- `created_at`
- optional `updated_at`
- optional `deleted_at`

## 6. User Management Route Mapping

## 6.1 `GET /api/users`

Backend mapping:

- implemented as `GET /v1/users`

Implemented behavior:

- owner-only access unless product rules explicitly broaden visibility
- optional `role` filter
- return normalized list with combined display name

## 6.2 `POST /api/users`

Backend mapping:

- implemented as `POST /v1/users`

Recommended backend request:

```json
{
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "doctor@example.com",
  "password": "strong-pass-123",
  "role": "doctor"
}
```

Frontend compatibility note:

- frontend currently sends `name`
- BFF must split `name` unless frontend is updated

## 7. Terminology Route Mapping

## 7.1 `GET /api/clinical/icd10?terms=...`

Backend mapping:

- currently missing

Recommended backend addition:

- `GET /v1/clinical/icd10?terms=...`

Recommended behavior:

- return empty list if fewer than 2 characters
- cap input length
- query ICD10 source table, file, or terminology service

## 8. Implementation Order

### Wave 1

- add backend `GET /v1/auth/me`
- add backend `GET /v1/auth/status`
- decide bootstrap register ownership

### Wave 2

- add patient delete endpoint
- design patient history table and routes
- decide patient `name` compatibility strategy

### Wave 3

- add users list/create endpoints
- add ICD10 lookup endpoint

### Wave 4

- move shared schemas into a common package if the BFF contract becomes stable

## 9. Non-Negotiable Decisions

These items must not stay implicit:

1. Whether the frontend BFF contract is the source of truth for browser-facing responses
2. Patient history is a dedicated backend resource backed by `patient_history_entries`
3. Whether `name` remains a single frontend field while backend keeps `firstName` and `lastName`
4. Whether auth bootstrap and session profile ownership live in frontend, backend, or both

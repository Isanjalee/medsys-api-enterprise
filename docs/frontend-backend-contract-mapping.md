# Frontend-Backend Contract Mapping

Current implementation mapping between:

- Frontend internal BFF contract: `/api/...`
- Backend domain API: `/v1/...`

Date: March 9, 2026
Status: Working integration mapping and implementation status tracker

## 1. Purpose

This document defines how the current frontend contract should map to the current backend API without forcing an immediate backend rewrite.

The intended near-term architecture is:

- Next.js `/api/...` remains the compatibility layer
- Fastify `/v1/...` remains the domain API
- request and response normalization happens in the BFF layer unless explicitly moved into the backend later

## 1.1 Current Delivery Status

This document also serves as the current backend contract-alignment status tracker.

Status meanings used below:

- `Not Started`: no backend implementation exists yet
- `In Progress`: implementation exists but does not yet match the frontend contract
- `Implemented`: backend endpoint exists and works, but contract verification is still incomplete
- `Blocked`: cannot be completed cleanly without an external dependency or architecture decision
- `Verified`: endpoint behavior, validation, authorization, and response shape match the frontend contract and are tested

## 1.2 Current Backend Status Summary

| Checklist ID | Capability | Current Status | Notes |
|---|---|---|---|
| `BE-001` | `POST /v1/auth/login` | Implemented | Issues tokens correctly, but token claims do not yet include frontend-friendly identity fields like `email` and `name` |
| `BE-002` | `POST /v1/auth/refresh` | Implemented | Refresh flow works and rotates tokens |
| `BE-003` | `POST /v1/auth/logout` | Not Started | No backend logout endpoint exists |
| `BE-004` | `GET /v1/auth/me` | Implemented | Endpoint exists, but response still includes backend-specific `organizationId` |
| `BE-005` | `GET /v1/patients` | Implemented | Response now returns frontend-compatible patient list shape |
| `BE-006` | `POST /v1/patients` | Implemented | Route now accepts frontend-compatible patient payloads and still tolerates backend-native payloads |
| `BE-007` | `GET /v1/patients/:id` | Implemented | Route now returns `{ patient, history }` in the frontend-oriented shape |
| `BE-008` | `PATCH /v1/patients/:id` | Implemented | Route now accepts frontend-compatible patch fields and returns normalized patient output |
| `BE-009` | `DELETE /v1/patients/:id` | Implemented | Soft delete exists and returns `{ success: true }` |
| `BE-010` | `GET /v1/patients/:id/history` | Implemented | Dedicated history resource exists and returns normalized actor metadata |
| `BE-011` | `POST /v1/patients/:id/history` | Implemented | Dedicated history write flow exists |
| `BE-012` | `GET /v1/users` | Implemented | Endpoint exists with role filtering and normalized list output |
| `BE-013` | `POST /v1/users` | Implemented | Route now accepts frontend-compatible `name` payloads and still tolerates backend-native fields |
| `BE-014` | `POST /v1/auth/register` | Implemented | Route now accepts frontend-compatible `name` payloads and preserves bootstrap-owner behavior |
| `BE-015` | `GET /v1/clinical/icd10` | Implemented | Backend terminology adapter exists and is provider-backed |
| `BE-016` | Shared validation layer | In Progress | Frontend-style validation envelopes now cover aligned auth, patient, user, and clinical flows, but are not yet standardized across the whole API |
| `BE-017` | Shared response mapping | In Progress | Some routes are normalized, but patient and auth alignment is incomplete |
| `BE-018` | Permission enforcement | Implemented | Shared permission mapping now covers the full `/v1` API surface, including older non-contract routes |
| `BE-019` | Contract tests | In Progress | Contract tests now cover core auth, patient, user, validation-envelope, and permission-denial paths, but coverage is still not complete across the whole API |
| `BE-020` | Store replacement | Not Started | No proof here that frontend prototype/store-backed routes are fully retired |

## 1.3 Main Remaining Gaps

The backend is no longer blocked by major missing endpoints. The main remaining work is:

- stable frontend-compatible validation error envelopes
- broader contract-level test coverage

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

Current implementation status:

- `BE-001`: `Implemented`

Remaining blockers and gaps:

- access token claims still do not expose frontend-oriented identity fields such as `email` and `name`
- error envelope still follows backend conventions rather than the frontend validation envelope

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

Current implementation status:

- `BE-003`: `Not Started`

Current blocker:

- backend logout remains an architecture decision because the current flow is still effectively stateless at the backend API surface

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

Current implementation status:

- `BE-004`: `Implemented`

Remaining blockers and gaps:

- backend response still includes `organizationId`, which is not part of the frontend contract
- final ownership of identity resolution between token claims and backend profile lookup is still a design choice

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

Current implementation status:

- implemented in backend

Remaining gap:

- not yet formally verified against the frontend BFF flow end-to-end

### 3.5 `POST /api/auth/register`

Frontend contract:

- first-user bootstrap can self-register as `owner`
- after bootstrap, registration requires `user.write`

Backend mapping:

- implemented as `POST /v1/auth/register`

Implemented behavior:

- if no users exist for the organization, allow owner bootstrap
- otherwise require authenticated actor with owner role

Current implementation status:

- `BE-014`: `Implemented`

Remaining blockers and gaps:

- frontend-side cookie/session bootstrap behavior is still owned by the BFF layer

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

Current implementation status:

- `BE-005`: `Implemented`

Remaining blockers and gaps:

- not yet verified against the shared frontend validation error envelope

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

- frontend contract still does not model backend-only clinical demographic fields such as `gender`

Current decision:

- backend now supports a compatibility create contract for frontend payloads

Recommended implementation:

- do not guess `gender`
- do not split `name` with brittle heuristics in production logic
- add a backend-compatible patient create endpoint or update the frontend contract

Interim fallback if business approves:

- BFF splits `name` into first token and remaining tokens
- BFF sends `gender: "other"`

This fallback is operationally weak and should be treated as temporary only.

Current implementation status:

- `BE-006`: `Implemented`

Remaining blockers and gaps:

- frontend-compatible requests are now supported, but the backend still defaults missing clinical-only fields internally
- validation failures still do not use the final frontend error envelope

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

Current state:

- frontend `history` is now backed by the dedicated patient history resource
- timeline remains a separate richer clinical concept

Recommended implementation:

- treat patient history as a new backend resource
- do not silently alias timeline to history unless the product owner approves the semantic change

Current implementation status:

- `BE-007`: `Implemented`

Remaining blockers and gaps:

- not yet verified against the shared frontend validation and error contract end-to-end

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

Current state:

- route now accepts frontend-compatible patch fields and still supports backend-native fields

Recommended implementation:

- if only `name` is provided, BFF must split it before calling backend
- longer-term fix is to align frontend and backend patient name fields explicitly

Current implementation status:

- `BE-008`: `Implemented`

Remaining blockers and gaps:

- route now supports frontend-compatible fields, but contract verification is still incomplete for the final error envelope

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

Current implementation status:

- `BE-009`: `Implemented`

Remaining blocker:

- permission alignment is still role-based rather than frontend permission-string based

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

Current implementation status:

- `BE-010`: `Implemented`

Remaining gap:

- not yet verified against the frontend validation and error-envelope contract end-to-end

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

Current implementation status:

- `BE-011`: `Implemented`

Remaining gap:

- contract-shape verification and frontend error-envelope alignment are still pending

## 6. User Management Route Mapping

## 6.1 `GET /api/users`

Backend mapping:

- implemented as `GET /v1/users`

Implemented behavior:

- owner-only access unless product rules explicitly broaden visibility
- optional `role` filter
- return normalized list with combined display name

Current implementation status:

- `BE-012`: `Implemented`

Remaining gap:

- permission mapping is still role-based and not expressed in shared permission terms such as `user.read`

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

Current implementation status:

- `BE-013`: `Implemented`

Remaining blockers and gaps:

- duplicate email behavior exists, but contract-level response verification is still pending

## 7. Terminology Route Mapping

## 7.1 `GET /api/clinical/icd10?terms=...`

Backend mapping:

- implemented as `GET /v1/clinical/icd10?terms=...`

Implemented behavior:

- return empty list if fewer than 2 characters
- cap input length
- query the configured ICD-10 provider via `ICD10_API_BASE_URL`

Current implementation status:

- `BE-015`: `Implemented`

Remaining blockers and gaps:

- provider dependency is now explicit and external
- latency, stability, and autocomplete ordering still need production verification

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

## 8.1 Cross-Cutting Status

### Shared validation layer

- `BE-016`: `In Progress`
- current state: backend now has a shared validation error type and frontend-style `400` envelope for auth, clinical, and the contract-aligned patient and user flows, including auxiliary patient writes such as vitals
- remaining blocker: validation and unknown-field rejection are still not standardized across every non-contract route in the API

### Shared response mapping

- `BE-017`: `In Progress`
- current state: some routes already serialize to frontend-like shapes, but patient and auth alignment is incomplete
- remaining blocker: no shared serializer layer exists across all contract-aligned routes

### Permission enforcement

- `BE-018`: `Implemented`
- current state: backend now has a shared permission catalog and permission-to-role mapping across the full `/v1` API surface
- remaining blocker: none at the route-guard level; future work is only permission-model refinement if the frontend needs more explicit capability granularity

### Contract tests

- `BE-019`: `In Progress`
- current state: backend tests now cover core auth identity, patient response shapes, validation-envelope behavior, and key permission-denial paths
- remaining blocker: broader coverage is still needed for non-contract routes and full end-to-end frontend integration paths

### Store replacement

- `BE-020`: `Not Started`
- current state: this backend repo cannot prove the frontend is fully off prototype/store-backed routes
- remaining blocker: frontend integration evidence is still required

## 9. Non-Negotiable Decisions

These items must not stay implicit:

1. Whether the frontend BFF contract is the source of truth for browser-facing responses
2. Patient history is a dedicated backend resource backed by `patient_history_entries`
3. Whether `name` remains a single frontend field while backend keeps `firstName` and `lastName`
4. Whether auth bootstrap and session profile ownership live in frontend, backend, or both

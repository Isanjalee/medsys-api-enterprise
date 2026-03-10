# Frontend to Backend Gap Analysis

Current comparison baseline between:

- Frontend internal contract: `/api/...` routes from the Medsys Next.js application
- Current backend implementation: `/v1/...` routes in `apps/api/src/routes`

Date: March 9, 2026
Status: Backend-side alignment largely implemented; frontend migration remains external to this repo

## 1. Executive Summary

The frontend contract and the current backend are **not yet directly compatible**.

The main mismatch is structural:

- the frontend contract is built around a **BFF-style internal `/api/...` layer**
- the backend currently exposes a **role-based domain API under `/v1/...`**
- request payloads, response shapes, permission semantics, and error envelopes do not line up cleanly

Because of that, the next implementation phase should be:

**Contract Alignment / Integration Layer**

This should be treated as the immediate implementation priority before starting a new domain roadmap phase.

## 2. Status Legend

- `Aligned`: current backend can satisfy the frontend contract with no meaningful change
- `Partial`: related backend capability exists, but payload/response/behavior differs
- `Missing`: no corresponding backend capability currently exists
- `Frontend-only`: behavior belongs to the Next.js BFF/session layer and should not be pushed into the backend as-is

## 3. High-Level Findings

### 3.1 What already exists in the backend

- login and refresh token endpoints
- patient CRUD-like capabilities, but with a different data shape
- appointments, encounters, prescriptions, inventory, analytics, audit
- role-based authorization using `owner | doctor | assistant`

### 3.2 What does not currently exist in the backend

- user management endpoints compatible with the frontend contract
- auth register endpoint
- auth logout matching the frontend contract
- frontend validation error envelope

### 3.3 Biggest integration differences

- frontend patient model uses `name`; backend uses `firstName`, `lastName`, `fullName`
- frontend patient detail returns `history`; backend returns clinical detail through profile/vitals/timeline/conditions/allergies
- frontend uses permission strings like `patient.read`; backend uses role checks
- frontend expects normalized validation errors; backend currently returns generic error payloads for most failures

### 3.4 Repository boundary

This workspace contains the backend only:

- `apps/api`
- `apps/worker`

There is no frontend or Next.js application in this repository. That means BFF migration, prototype-store removal, and end-to-end frontend verification are blocked outside this codebase.

## 4. Route-by-Route Comparison

| Frontend Route | Frontend Expectation | Current Backend Match | Status | Required Action |
|---|---|---|---|---|
| `POST /api/auth/login` | Accepts `email`, `password`, optional `roleHint`, optional `organizationId`; returns normalized user profile after token handling | Backend has `POST /v1/auth/login`, but requires `organizationId`, ignores `roleHint`, and returns tokens instead of a frontend session-shaped user object | Partial | Keep this in BFF layer and map backend token response to frontend session response |
| `POST /api/auth/logout` | Clears cookies and session | No equivalent backend route required | Frontend-only | Keep in Next.js layer |
| `GET /api/auth/me` | Returns signed-in user session profile | Backend now has `GET /v1/auth/me`, but the BFF still needs to map it into the frontend session flow | Partial | Use backend `GET /v1/auth/me` as the canonical session profile source |
| `GET /api/auth/status` | Returns bootstrap status and user count | Backend now has `GET /v1/auth/status` with matching core behavior | Aligned | Expose through the BFF or call backend directly |
| `/api/backend/:path*` | Authenticated proxy with refresh retry | Not a backend concern | Frontend-only | Keep in Next.js layer |
| `GET /api/patients` | Returns `{ patients: [...] }` with `name`, `date_of_birth`, `phone`, `address`, `created_at` | Backend has `GET /v1/patients`, but fields are different and response is a raw array | Partial | Add response mapping in BFF or normalize backend output |
| `POST /api/patients` | Accepts `name`, `dateOfBirth`, `phone`, `address` | Backend expects `firstName`, `lastName`, `gender`, optional DOB and more fields | Partial | Define name-splitting strategy or extend backend with simplified patient create contract |
| `GET /api/patients/:id` | Returns `{ patient, history }` | Backend has `GET /v1/patients/:id`, but no `history`; current detail model is different | Partial | Add adapter mapping and decide whether `history` maps to timeline or requires new backend table |
| `PATCH /api/patients/:id` | Partial update on `name`, `dateOfBirth`, `phone`, `address` | Backend supports patch, but on different field names and broader schema | Partial | Add translation layer or backend alias fields |
| `DELETE /api/patients/:id` | Soft or hard delete patient | Backend now has `DELETE /v1/patients/:id` as a soft delete | Aligned | Map response to `{ success: true }` in the BFF if needed |
| `GET /api/patients/:id/history` | Returns note history entries | Backend now has `GET /v1/patients/:id/history` backed by a dedicated history table | Aligned | Use backend history resource as the source of truth |
| `POST /api/patients/:id/history` | Adds note history entry | Backend now has `POST /v1/patients/:id/history` | Aligned | Use backend history write flow |
| `GET /api/users` | Lists users, optional role filter | Backend now has `GET /v1/users`, with owner-only access and optional role filtering | Partial | BFF still needs to split or compose `name` if it remains the frontend source field |
| `POST /api/users` | Creates users with `name`, `email`, `password`, `role` | Backend now has `POST /v1/users`, but it expects `firstName` and `lastName` | Partial | BFF must split frontend `name` or frontend schema must change |
| `POST /api/auth/register` | Bootstrap owner registration, then controlled registration | Backend now has `POST /v1/auth/register` with bootstrap-owner behavior and owner-only post-bootstrap registration | Partial | BFF still needs to map frontend `name` to backend first/last names |
| `GET /api/clinical/icd10` | Returns ICD10 suggestions | Backend now has `GET /v1/clinical/icd10`, backed by the NLM Clinical Tables ICD-10-CM API | Aligned | Use backend endpoint as the terminology adapter and keep the provider dependency server-side |

## 5. Authorization Model Mismatch

### Frontend

The frontend contract uses permission strings such as:

- `patient.read`
- `patient.write`
- `patient.delete`
- `patient.history.read`
- `patient.history.write`
- `user.read`
- `user.write`
- `clinical.icd10.read`

### Backend

The backend currently uses route-level role checks:

- `owner`
- `doctor`
- `assistant`

### Gap

There is no shared permission-to-role mapping package between the two layers right now.

### Required action

Create a shared authorization mapping document or package that explicitly states:

- which roles satisfy which frontend permissions
- which routes are role-based in the backend
- whether the frontend permission model remains the source of truth

## 6. Validation and Error Model Mismatch

### Frontend expectation

Validation errors must return:

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

### Backend current behavior

The backend currently uses:

- Zod parsing at route level
- a generic error handler returning:

```json
{
  "message": "...",
  "requestId": "..."
}
```

### Gap

The frontend validation envelope is **not currently implemented** in the backend.

### Required action

Choose one of these paths:

1. Keep validation/error normalization inside the Next.js BFF layer
2. Standardize backend errors to the frontend envelope
3. Introduce a shared error schema package used by both layers

## 7. Data Shape Mismatch

### Patient naming

Frontend:

- `name`

Backend:

- `firstName`
- `lastName`
- `fullName`

This requires either:

- BFF transformation logic, or
- backend contract changes, or
- frontend schema changes

### Patient history

Frontend expects:

- a simple note-based patient history list

Backend currently has:

- allergies
- conditions
- vitals
- timeline

This is not the same concept. It must be explicitly decided whether:

- `history` should be a new backend resource, or
- frontend `history` should be remapped to backend timeline

### User management

Frontend contract expects a simpler user administration model than the backend currently exposes.

## 8. Recommended Integration Direction

The lowest-risk approach is:

### Recommended

Keep the Next.js `/api/...` layer as the **compatibility adapter** for now.

That layer should:

- validate frontend payloads exactly as documented
- map frontend request models into backend `/v1/...` payloads
- map backend responses into frontend-normalized response envelopes
- translate backend errors into frontend validation/error responses where appropriate

### Why this is the best next step

- it avoids breaking the current backend domain API
- it avoids forcing a premature backend rewrite
- it lets frontend and backend evolve while preserving a stable internal contract

## 9. Recommended Implementation Order

### Wave 1: Auth alignment

- finalize login mapping
- define logout/me/status behavior
- define refresh/session ownership between frontend BFF and backend

### Wave 2: Patient contract alignment

- map patient list/create/get/update
- resolve `name` vs `firstName/lastName`
- decide patient history implementation

### Wave 3: User administration

- add users list/create
- add bootstrap register behavior

### Wave 4: Clinical helpers

- add ICD10 lookup endpoint

## 10. Immediate Next Deliverables

The next concrete artifacts to create are:

1. `frontend-backend-contract-mapping.md`
2. `authorization-permission-mapping.md`
3. route implementation plan for:
   - auth
   - patients
   - users
   - patient history
   - ICD10 suggestions

## 11. Decision Items Requiring Confirmation

Before implementation moves too far, these must be explicitly decided:

1. Is the frontend BFF contract the source of truth, or should the backend become the source of truth?
2. Should patient `history` be a new backend resource or a mapping to existing timeline data?
3. Should backend auth expose `me`, `status`, and `register`, or should those stay in the frontend layer?
4. Should frontend permissions remain permission-string based while backend stays role-based, or should both be unified?

## 12. Recommended Next Engineering Task

The best immediate task is:

**build the route-by-route compatibility layer plan for auth and patients first**

That is the fastest path to a working integrated system without rewriting the entire backend surface.

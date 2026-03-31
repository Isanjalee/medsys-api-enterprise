# Identity Migration Tracker

This tracker records implementation progress for the long-term identity model:

- `roles` = identity categories
- `active_role` = current workspace context
- `permissions` = allowed actions
- `workflow_profiles` = operational behavior by role

## Phase Status

- [x] Phase 1: Add additive response fields on auth and user APIs
  - `roles`
  - `active_role`
  - `workflow_profiles`
  - legacy compatibility fields remain in place:
    - `role`
    - `doctor_workflow_mode`
- [x] Phase 2: Keep current doctor workflow behavior explicit
  - `doctor_workflow_mode`
  - consultation save `workflow_type`
  - consultation save `appointment_id`
  - waiting queue `queuePosition`
- [x] Phase 3: Add tests for the additive identity response contract
- [x] Phase 4: Persist true multi-role support in the database
  - added `user_roles` table
  - support `owner + doctor`
  - persist `active_role`
- [x] Phase 5: Update auth/session model for true multi-role users
  - resolve multiple roles per user
  - return persisted `active_role`
  - keep legacy `role` aligned to `active_role` for compatibility
- [x] Phase 6: Add request validation and mutation APIs for multi-role management
  - create/update users with multiple roles
  - switch active role safely with `POST /v1/auth/active-role`
- [x] Phase 7: Decide long-term workflow profile persistence model
  - current repo implementation uses computed `workflow_profiles`
  - doctor mode persists via `doctor_workflow_mode`
  - owner/assistant use computed `"standard"` mode until a richer business model is needed
- [x] Phase 8: Expand role-specific analytics and AI contracts
  - analytics now return additive `role_context`
  - AI contract documented as role-aware and reserved for a future API because this repo does not yet expose an AI route
- [ ] Phase 9: Deprecate legacy single-role compatibility fields after frontend migration

## Completed In This Iteration

- Added persistent multi-role support with `user_roles` and `users.active_role`
- Updated auth/session resolution to load real role assignments from the database
- Added create/update/switch flows for multi-role identity management
- Aligned effective permissions with the full assigned role set
- Added role-aware analytics response context without breaking existing counters
- Added repo-level tracking for completed and remaining migration work

## Not Completed Yet

- Legacy field deprecation after frontend rollout:
  - `role`
  - `doctor_workflow_mode`
- A dedicated AI API that consumes the new role-aware identity model
- Richer persisted workflow modes for owner/assistant if future product requirements require them

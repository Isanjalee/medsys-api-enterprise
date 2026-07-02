-- family_code was globally UNIQUE, but the portal creates one family per clinic using the
-- code SRF-{accountId}. So the moment an account linked doctors in a second clinic, inserting
-- SRF-{accountId} again collided (families_family_code_key) → 500 on every cross-clinic link.
-- Make it unique PER ORGANISATION instead, which is what the code always assumed.

ALTER TABLE families DROP CONSTRAINT IF EXISTS families_family_code_key;
ALTER TABLE families
  ADD CONSTRAINT families_org_family_code_unique UNIQUE (organization_id, family_code);

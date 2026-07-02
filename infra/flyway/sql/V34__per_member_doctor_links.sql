-- Per-member doctor links: each family member (or the account holder) links their own
-- doctors, each with a custom tag ("Family doctor", "Dental", …). member_id is null for
-- the account holder's own links. Uniqueness moves to (account, doctor, patient) so
-- several members can link the same doctor (they map to distinct clinic patients).

ALTER TABLE patient_doctor_links ADD COLUMN IF NOT EXISTS member_id BIGINT REFERENCES patient_account_members(id);
ALTER TABLE patient_doctor_links ADD COLUMN IF NOT EXISTS label VARCHAR(60);

ALTER TABLE patient_doctor_links DROP CONSTRAINT IF EXISTS patient_doctor_links_unique;
ALTER TABLE patient_doctor_links
  ADD CONSTRAINT patient_doctor_links_unique UNIQUE (patient_account_id, doctor_user_id, patient_id);

CREATE INDEX IF NOT EXISTS patient_doctor_links_member_idx ON patient_doctor_links (member_id);

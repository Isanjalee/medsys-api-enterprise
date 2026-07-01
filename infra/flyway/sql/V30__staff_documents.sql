-- Extend patient_documents so clinic staff (assistant/doctor) can upload documents
-- for a patient, not only patient-portal self-uploads. Staff uploads have no portal
-- account and no single target doctor, so those columns become nullable, and we track
-- who uploaded it and where it came from.

ALTER TABLE patient_documents ALTER COLUMN patient_account_id DROP NOT NULL;
ALTER TABLE patient_documents ALTER COLUMN doctor_user_id DROP NOT NULL;

ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS uploaded_by_user_id BIGINT REFERENCES users(id);
-- 'patient' = portal self-upload (existing rows), 'assistant' = uploaded by clinic staff.
ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'patient';
ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS note TEXT;

-- Powers the doctor's org-wide "Report Review" queue (most recent first).
CREATE INDEX IF NOT EXISTS patient_documents_review_idx
  ON patient_documents (organization_id, uploaded_at DESC);

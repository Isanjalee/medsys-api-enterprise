-- Track a doctor's review of a document (report-review workflow). Once reviewed, the
-- document leaves the "awaiting review" queue and shows a "Doctor reviewed" status to
-- the patient on the portal.

ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS reviewed_by_user_id BIGINT REFERENCES users(id);

-- Fast lookup of the pending (unreviewed) queue per org.
CREATE INDEX IF NOT EXISTS patient_documents_pending_review_idx
  ON patient_documents (organization_id, reviewed_at);

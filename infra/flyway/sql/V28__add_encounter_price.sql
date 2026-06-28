-- Consultation price (LKR), entered by the doctor at consultation time. Stored on the
-- encounter so every consultation can carry a price regardless of whether it produced a
-- prescription. Whole-rupee amounts (no decimals) are expected from the UI. Nullable so
-- historical encounters are unaffected.

ALTER TABLE encounters
  ADD COLUMN IF NOT EXISTS price_lkr NUMERIC(12, 2) NULL;

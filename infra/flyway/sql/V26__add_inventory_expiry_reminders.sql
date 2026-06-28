-- Per-item expiry reminder preferences. The drug's expiry_date column already exists
-- (V15/V17); these flags control which lead-time reminders (3 / 2 / 1 months before
-- expiry) are active for the item. Default ON so existing items are reminded by default.

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS remind_before_3m BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS remind_before_2m BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS remind_before_1m BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS dispense_unit VARCHAR(20),
  ADD COLUMN IF NOT EXISTS dispense_unit_size NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS purchase_unit VARCHAR(20),
  ADD COLUMN IF NOT EXISTS purchase_unit_size NUMERIC(12, 2);

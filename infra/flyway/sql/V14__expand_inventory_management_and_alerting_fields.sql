ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS package_unit VARCHAR(20),
  ADD COLUMN IF NOT EXISTS package_size NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS brand_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS lead_time_days BIGINT;

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS reason VARCHAR(30),
  ADD COLUMN IF NOT EXISTS note TEXT;

CREATE INDEX IF NOT EXISTS inventory_items_org_supplier_idx ON inventory_items (organization_id, supplier_name);
CREATE INDEX IF NOT EXISTS inventory_movements_org_created_idx ON inventory_movements (organization_id, created_at);

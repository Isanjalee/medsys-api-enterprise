CREATE TABLE IF NOT EXISTS inventory_batches (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  inventory_item_id BIGINT NOT NULL REFERENCES inventory_items(id),
  batch_no VARCHAR(80) NOT NULL,
  expiry_date DATE,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
  supplier_name VARCHAR(120),
  storage_location VARCHAR(120),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS inventory_batches_item_idx ON inventory_batches(inventory_item_id);
CREATE INDEX IF NOT EXISTS inventory_batches_org_expiry_idx ON inventory_batches(organization_id, expiry_date);

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS batch_id BIGINT REFERENCES inventory_batches(id);

INSERT INTO inventory_batches (
  organization_id,
  inventory_item_id,
  batch_no,
  expiry_date,
  quantity,
  supplier_name,
  storage_location,
  received_at,
  is_active,
  created_at,
  updated_at,
  deleted_at
)
SELECT
  organization_id,
  id,
  COALESCE(batch_no, CONCAT('LEGACY-', id)),
  expiry_date,
  stock,
  supplier_name,
  storage_location,
  created_at,
  is_active,
  created_at,
  updated_at,
  deleted_at
FROM inventory_items
WHERE stock > 0
  AND NOT EXISTS (
    SELECT 1 FROM inventory_batches b WHERE b.inventory_item_id = inventory_items.id
  );

-- Home banners managed by the platform (super) admin: an image + optional title and a
-- click-through URL, shown in the patient portal's auto-sliding home carousel.

CREATE TABLE banners (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(160),
  image_key VARCHAR(400) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  target_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX banners_active_sort_idx ON banners (is_active, sort_order, id);

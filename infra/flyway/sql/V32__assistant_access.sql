-- Universal capability model: remove the clinic Operating Mode gating (walk-in +
-- appointments are always available now) and let the owner choose which pages each
-- clinic's assistants can access.
--
-- assistant_access holds the list of nav ids assistants may open (e.g.
-- ["patient","inventory","tasks","documents","appointments"]). NULL means "all pages"
-- so existing clinics are unchanged until the owner customises it. operating_mode is
-- kept (nullable/ignored) to avoid touching historical rows; the app no longer gates on it.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS assistant_access JSONB;
ALTER TABLE organizations ALTER COLUMN operating_mode SET DEFAULT 'standard';
UPDATE organizations SET operating_mode = 'standard' WHERE operating_mode IS DISTINCT FROM 'standard';

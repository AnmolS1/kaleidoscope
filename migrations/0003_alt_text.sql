-- Accessibility v1.1: per-artwork alt text. Populated with a deterministic
-- template value at save time (never null going forward) and opportunistically
-- upgraded to an AI-generated description. Nullable so existing rows backfill
-- lazily via the admin backfill route.
ALTER TABLE artworks ADD COLUMN alt_text TEXT;

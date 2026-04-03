-- 011: Add memory_photo_url column to couple_rooms
-- Stores the object storage URL instead of base64 data directly in the DB.
-- The old memory_photo_base64 column is kept for backward compatibility during migration.

ALTER TABLE couple_rooms ADD COLUMN IF NOT EXISTS memory_photo_url TEXT;
ALTER TABLE couple_rooms ADD COLUMN IF NOT EXISTS memory_photo_key TEXT;

-- Index for cleanup queries (find rooms with stored photos)
CREATE INDEX IF NOT EXISTS idx_couple_rooms_photo_key ON couple_rooms(memory_photo_key) WHERE memory_photo_key IS NOT NULL;

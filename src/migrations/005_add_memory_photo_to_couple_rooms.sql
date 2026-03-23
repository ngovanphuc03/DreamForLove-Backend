-- Add shared memory photo (base64) per couple room so both devices see the same image
ALTER TABLE couple_rooms
ADD COLUMN IF NOT EXISTS memory_photo_base64 TEXT;
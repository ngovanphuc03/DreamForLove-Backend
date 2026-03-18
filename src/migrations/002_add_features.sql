-- 1. Add audio_url to mood_logs
ALTER TABLE mood_logs ADD COLUMN IF NOT EXISTS audio_url TEXT;

-- 2. Add is_eaten and last_eaten_at to food_items
ALTER TABLE food_items ADD COLUMN IF NOT EXISTS is_eaten BOOLEAN DEFAULT FALSE;
ALTER TABLE food_items ADD COLUMN IF NOT EXISTS last_eaten_at TIMESTAMPTZ;

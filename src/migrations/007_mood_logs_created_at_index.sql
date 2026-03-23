-- 007_mood_logs_created_at_index.sql
-- Improve mood daily and timeline queries by room + recency.

CREATE INDEX IF NOT EXISTS idx_mood_logs_room_created_desc
    ON mood_logs (couple_room_id, created_at DESC);

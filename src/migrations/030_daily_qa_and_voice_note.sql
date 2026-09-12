-- Migration 030: Add daily_couple_qa table and voice note fields to mood_logs

-- 1. Daily Couple Q&A Table (Dual Unlock / Mutual Reveal)
CREATE TABLE IF NOT EXISTS daily_couple_qa (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    couple_room_id UUID NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    qa_date DATE NOT NULL,
    question_text TEXT NOT NULL,
    user_a_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_a_answer TEXT,
    user_a_answered_at TIMESTAMPTZ,
    user_b_id UUID REFERENCES users(id) ON DELETE CASCADE,
    user_b_answer TEXT,
    user_b_answered_at TIMESTAMPTZ,
    is_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_couple_daily_qa UNIQUE (couple_room_id, qa_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_couple_qa_room_date
ON daily_couple_qa(couple_room_id, qa_date DESC);

-- 2. Voice Note columns on mood_logs
ALTER TABLE mood_logs ADD COLUMN IF NOT EXISTS voice_note_base64 TEXT;
ALTER TABLE mood_logs ADD COLUMN IF NOT EXISTS voice_duration_seconds INT DEFAULT 0;

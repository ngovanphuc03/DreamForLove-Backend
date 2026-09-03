-- 024_period_daily_logs.sql: Daily symptom logging and cycle history for Flo-level tracking

CREATE TABLE IF NOT EXISTS couple_period_daily_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    couple_room_id UUID NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    log_date DATE NOT NULL,
    flow_level INT DEFAULT 0,
    pain_level INT DEFAULT 0,
    moods JSONB DEFAULT '[]'::jsonb,
    symptoms JSONB DEFAULT '[]'::jsonb,
    cervical_mucus VARCHAR(50) DEFAULT NULL,
    temperature NUMERIC(4,2) DEFAULT NULL,
    notes TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_period_daily_log UNIQUE (couple_room_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_period_daily_logs_room_date ON couple_period_daily_logs(couple_room_id, log_date DESC);

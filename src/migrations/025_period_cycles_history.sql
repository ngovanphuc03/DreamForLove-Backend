-- 025_period_cycles_history.sql: Cycle history tracking and statistics for Flo-level prediction

CREATE TABLE IF NOT EXISTS couple_period_cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    couple_room_id UUID NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    cycle_number INT NOT NULL DEFAULT 1,
    start_date DATE NOT NULL,
    end_date DATE,
    cycle_length INT,
    period_duration INT DEFAULT 5,
    is_predicted BOOLEAN DEFAULT false,
    notes TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_room_cycle_start UNIQUE (couple_room_id, start_date)
);

CREATE INDEX IF NOT EXISTS idx_couple_period_cycles_room ON couple_period_cycles(couple_room_id, start_date DESC);

-- 009_create_trip_plans.sql
-- Shared future travel/date plans for each couple room.

CREATE TABLE IF NOT EXISTS trip_plans (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_room_id  UUID        NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    added_by        UUID        NOT NULL REFERENCES users(id),
    title           VARCHAR(120) NOT NULL,
    location        VARCHAR(255) NOT NULL,
    note            TEXT,
    planned_date    DATE,
    is_done         BOOLEAN     DEFAULT FALSE,
    is_deleted      BOOLEAN     DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_plans_room_active
    ON trip_plans (couple_room_id, is_done, planned_date, created_at DESC)
    WHERE is_deleted = FALSE;

CREATE TRIGGER trg_trip_plans_updated_at
    BEFORE UPDATE ON trip_plans
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

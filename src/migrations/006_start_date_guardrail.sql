-- 006_start_date_guardrail.sql
-- Prevent invalid couple start dates in the future.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_couple_rooms_start_date_not_future'
    ) THEN
        ALTER TABLE couple_rooms
            ADD CONSTRAINT chk_couple_rooms_start_date_not_future
            CHECK (start_date <= CURRENT_DATE) NOT VALID;
    END IF;
END $$;

ALTER TABLE couple_rooms
    VALIDATE CONSTRAINT chk_couple_rooms_start_date_not_future;

-- 026_period_medical_biomarkers.sql: Add clinical biomarkers and contraception logging for Flo/ACOG standards

ALTER TABLE couple_period_daily_logs
    ADD COLUMN IF NOT EXISTS lh_test VARCHAR(20),
    ADD COLUMN IF NOT EXISTS intimacy VARCHAR(20),
    ADD COLUMN IF NOT EXISTS contraceptive VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_period_daily_logs_intimacy ON couple_period_daily_logs(couple_room_id, log_date) WHERE intimacy IS NOT NULL;

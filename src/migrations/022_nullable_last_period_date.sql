-- 022_nullable_last_period_date.sql: Make last_period_date nullable so role selection does not inject fake period date
ALTER TABLE couple_period_settings ALTER COLUMN last_period_date DROP NOT NULL;

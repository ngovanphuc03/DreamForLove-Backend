-- 021_add_female_user_id.sql: Add female_user_id to couple_period_settings for automatic role detection
ALTER TABLE couple_period_settings ADD COLUMN IF NOT EXISTS female_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

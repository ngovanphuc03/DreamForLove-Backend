-- 019_food_enhancements.sql: Add eat_count, is_favorite, category, notes to food_items and create food_history table

ALTER TABLE food_items ADD COLUMN IF NOT EXISTS eat_count INT DEFAULT 0;
ALTER TABLE food_items ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT FALSE;
ALTER TABLE food_items ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'Khác';
ALTER TABLE food_items ADD COLUMN IF NOT EXISTS notes TEXT;

-- Create index for favorite and category lookups
CREATE INDEX IF NOT EXISTS idx_food_items_favorite ON food_items(couple_room_id, is_favorite) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_food_items_category ON food_items(couple_room_id, category) WHERE NOT is_deleted;

-- Table for logging meals eaten by couples
CREATE TABLE IF NOT EXISTS food_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    couple_room_id UUID NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    food_id UUID REFERENCES food_items(id) ON DELETE SET NULL,
    food_name VARCHAR(100) NOT NULL,
    food_emoji VARCHAR(10) DEFAULT '🍜',
    eaten_by UUID REFERENCES users(id) ON DELETE SET NULL,
    eaten_at TIMESTAMPTZ DEFAULT NOW(),
    notes TEXT,
    is_deleted BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_food_history_room ON food_history(couple_room_id, eaten_at DESC);

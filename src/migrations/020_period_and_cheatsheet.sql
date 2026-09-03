-- 020_period_and_cheatsheet.sql: Create period settings & partner cheatsheet tables

-- 1. Table for Period & PMS Care Tracker
CREATE TABLE IF NOT EXISTS couple_period_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    couple_room_id UUID NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    last_period_date DATE NOT NULL,
    cycle_length INT NOT NULL DEFAULT 28,
    period_duration INT NOT NULL DEFAULT 5,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_couple_period_room UNIQUE (couple_room_id)
);

CREATE INDEX IF NOT EXISTS idx_couple_period_room ON couple_period_settings(couple_room_id);

-- 2. Table for Partner's Cheatsheet (Gu Của Người Ấy)
CREATE TABLE IF NOT EXISTS partner_cheatsheets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    couple_room_id UUID NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    drink_name VARCHAR(255) DEFAULT '',
    drink_sugar VARCHAR(50) DEFAULT '',
    drink_ice VARCHAR(50) DEFAULT '',
    drink_topping VARCHAR(255) DEFAULT '',
    drink_notes TEXT DEFAULT '',
    food_dislikes TEXT DEFAULT '',
    food_spice_level VARCHAR(100) DEFAULT '',
    food_allergies TEXT DEFAULT '',
    favorite_dishes TEXT DEFAULT '',
    shoe_size VARCHAR(50) DEFAULT '',
    clothing_size VARCHAR(50) DEFAULT '',
    ring_size VARCHAR(50) DEFAULT '',
    style_notes TEXT DEFAULT '',
    lipstick_shade VARCHAR(255) DEFAULT '',
    favorite_scent VARCHAR(255) DEFAULT '',
    special_notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_partner_cheatsheet_user UNIQUE (couple_room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_partner_cheatsheet_room ON partner_cheatsheets(couple_room_id);

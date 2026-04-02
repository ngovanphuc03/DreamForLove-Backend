-- ═══════════════════════════════════════════════════════════════
--  014 – Pet RPG Overhaul 
--  Adds inventory, premium currency, and evolution locks
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Premium Currency for Couples ────────────────────────────
ALTER TABLE couple_rooms ADD COLUMN IF NOT EXISTS love_coins INT NOT NULL DEFAULT 50 CHECK (love_coins >= 0);

-- ── 2. Pet Inventory Table ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS pet_inventory (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_room_id  UUID        NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    item_id         VARCHAR(50) NOT NULL,
    quantity        INT         NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(couple_room_id, item_id)
);

CREATE TRIGGER trg_pet_inventory_updated_at
    BEFORE UPDATE ON pet_inventory
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 3. Add Evolution Lock to Pet ───────────────────────────────
ALTER TABLE couple_pet ADD COLUMN IF NOT EXISTS requires_evolution_stone BOOLEAN NOT NULL DEFAULT false;

-- Add tracking for Yin-Yang balance (Lifetime Interaction Counts)
ALTER TABLE couple_pet ADD COLUMN IF NOT EXISTS user1_interactions INT NOT NULL DEFAULT 0;
ALTER TABLE couple_pet ADD COLUMN IF NOT EXISTS user2_interactions INT NOT NULL DEFAULT 0;

-- Optionally grant some initial starter items to existing pets
INSERT INTO pet_inventory (couple_room_id, item_id, quantity)
SELECT id, 'basic_food', 10 FROM couple_rooms ON CONFLICT DO NOTHING;

INSERT INTO pet_inventory (couple_room_id, item_id, quantity)
SELECT id, 'basic_soap', 5 FROM couple_rooms ON CONFLICT DO NOTHING;

INSERT INTO pet_inventory (couple_room_id, item_id, quantity)
SELECT id, 'basic_toy', 5 FROM couple_rooms ON CONFLICT DO NOTHING;

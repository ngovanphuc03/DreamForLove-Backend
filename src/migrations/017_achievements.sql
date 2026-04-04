-- ═══════════════════════════════════════════════════════════════
--  017 – Pet Achievement System
--  Tracks unlocked milestones for couple pet progression
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pet_achievements (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_room_id  UUID        NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    achievement_id  VARCHAR(64) NOT NULL,
    progress        INT         NOT NULL DEFAULT 0,
    target          INT         NOT NULL DEFAULT 1,
    unlocked        BOOLEAN     NOT NULL DEFAULT false,
    unlocked_at     TIMESTAMPTZ,
    coins_rewarded  INT         NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (couple_room_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS idx_pet_achievements_room
    ON pet_achievements (couple_room_id);

CREATE TRIGGER trg_pet_achievements_updated_at
    BEFORE UPDATE ON pet_achievements
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

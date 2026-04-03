-- ═══════════════════════════════════════════════════════════════
--  013 – Couple Pet Game tables
--  Adds couple_pet (main pet state) and pet_care_actions (log)
-- ═══════════════════════════════════════════════════════════════

-- ── Main pet state per couple room ─────────────────────────────
CREATE TABLE IF NOT EXISTS couple_pet (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_room_id  UUID        NOT NULL UNIQUE REFERENCES couple_rooms(id) ON DELETE CASCADE,
    pet_name        VARCHAR(64) NOT NULL DEFAULT 'Bé Yêu',

    -- Pet stats (0-100)
    health          INT NOT NULL DEFAULT 80 CHECK (health >= 0 AND health <= 100),
    mood            INT NOT NULL DEFAULT 80 CHECK (mood >= 0 AND mood <= 100),
    hunger          INT NOT NULL DEFAULT 80 CHECK (hunger >= 0 AND hunger <= 100),
    cleanliness     INT NOT NULL DEFAULT 80 CHECK (cleanliness >= 0 AND cleanliness <= 100),

    -- Evolution
    evolution_level INT NOT NULL DEFAULT 1 CHECK (evolution_level >= 1 AND evolution_level <= 8),
    total_love_xp   INT NOT NULL DEFAULT 0 CHECK (total_love_xp >= 0),

    -- Timestamps for last actions
    last_fed_at     TIMESTAMPTZ,
    last_played_at  TIMESTAMPTZ,
    last_bathed_at  TIMESTAMPTZ,
    last_petted_at  TIMESTAMPTZ,
    last_decay_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Habitat customization (future use)
    habitat_config  JSONB NOT NULL DEFAULT '{"theme": "default", "items": []}'::jsonb,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Pet care action log ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pet_care_actions (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_room_id  UUID        NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_type     VARCHAR(32) NOT NULL, -- 'feed', 'play', 'bathe', 'pet', 'sleep'
    xp_awarded      INT         NOT NULL DEFAULT 0,
    stat_changes    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pet_care_room_date ON pet_care_actions(couple_room_id, created_at DESC);
CREATE INDEX idx_pet_care_user_date ON pet_care_actions(user_id, created_at DESC);

-- ── Auto-update updated_at trigger ─────────────────────────────
CREATE TRIGGER trg_couple_pet_updated_at
    BEFORE UPDATE ON couple_pet
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

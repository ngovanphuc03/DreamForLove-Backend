-- ═══════════════════════════════════════════════════════════════
--  DreamForLove – PostgreSQL Schema v1.0
--  Multi-tenant design: all data scoped by couple_room_id
--  Critical indexes on couple_room_id for query performance
-- ═══════════════════════════════════════════════════════════════

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- for fuzzy search

-- ── ENUM Types ───────────────────────────────────────────────
CREATE TYPE wish_priority AS ENUM ('low', 'mid', 'high');
CREATE TYPE mood_type     AS ENUM ('happy', 'sad', 'miss', 'angry', 'love');
CREATE TYPE room_status   AS ENUM ('active', 'inactive', 'deleted');

-- ────────────────────────────────────────────────────────────
-- TABLE: users
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    firebase_uid    VARCHAR(128) UNIQUE NOT NULL,
    email           VARCHAR(255),
    display_name    VARCHAR(100),
    photo_url       TEXT,
    fcm_token       TEXT,
    provider        VARCHAR(20)  DEFAULT 'google',
    is_premium      BOOLEAN      DEFAULT FALSE,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX idx_users_firebase_uid ON users(firebase_uid);

-- ────────────────────────────────────────────────────────────
-- TABLE: couple_rooms  (Multi-tenant anchor)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS couple_rooms (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_a_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b_id       UUID        REFERENCES users(id) ON DELETE SET NULL,
    start_date      DATE        NOT NULL,
    status          room_status DEFAULT 'active',
    is_premium      BOOLEAN     DEFAULT FALSE,
    -- Soft-delete tracking
    deactivated_at  TIMESTAMPTZ,
    delete_after    TIMESTAMPTZ,  -- = deactivated_at + 30 days
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX idx_couple_rooms_user_a   ON couple_rooms(user_a_id);
CREATE INDEX idx_couple_rooms_user_b   ON couple_rooms(user_b_id);
CREATE INDEX idx_couple_rooms_status   ON couple_rooms(status);
CREATE INDEX idx_couple_rooms_delete   ON couple_rooms(delete_after)
    WHERE delete_after IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- TABLE: pairing_codes  (6-digit short-lived codes)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pairing_codes (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    code        CHAR(6)     UNIQUE NOT NULL,
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
    used        BOOLEAN     DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pairing_codes_code   ON pairing_codes(code) WHERE NOT used;
CREATE INDEX idx_pairing_codes_expiry ON pairing_codes(expires_at);

-- ────────────────────────────────────────────────────────────
-- TABLE: wish_items
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wish_items (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_room_id  UUID            NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    added_by        UUID            NOT NULL REFERENCES users(id),
    name            VARCHAR(255)    NOT NULL,
    category        VARCHAR(100)    NOT NULL DEFAULT 'Khác',
    price           NUMERIC(12, 0)  DEFAULT 0,
    priority        wish_priority   DEFAULT 'low',
    image_url       TEXT,
    product_url     TEXT,
    is_bought       BOOLEAN         DEFAULT FALSE,
    bought_at       TIMESTAMPTZ,
    is_deleted      BOOLEAN         DEFAULT FALSE,
    created_at      TIMESTAMPTZ     DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     DEFAULT NOW()
);

-- ★ Critical index for multi-tenant queries
CREATE INDEX idx_wish_items_room      ON wish_items(couple_room_id) WHERE NOT is_deleted;
CREATE INDEX idx_wish_items_priority  ON wish_items(couple_room_id, priority);
CREATE INDEX idx_wish_items_bought    ON wish_items(couple_room_id, is_bought);

-- ────────────────────────────────────────────────────────────
-- TABLE: mood_logs
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mood_logs (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_room_id  UUID        NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            mood_type   NOT NULL,
    note            TEXT,
    audio_url       TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ★ Critical index (no partial index on CURRENT_DATE — not IMMUTABLE in PostgreSQL)
CREATE INDEX idx_mood_logs_room    ON mood_logs(couple_room_id, user_id, created_at DESC);

-- ────────────────────────────────────────────────────────────
-- TABLE: food_items
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS food_items (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_room_id  UUID        NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    added_by        UUID        NOT NULL REFERENCES users(id),
    name            VARCHAR(100) NOT NULL,
    emoji           VARCHAR(10)  DEFAULT '🍜',
    location        VARCHAR(255),
    is_deleted      BOOLEAN      DEFAULT FALSE,
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ★ Critical index
CREATE INDEX idx_food_items_room ON food_items(couple_room_id) WHERE NOT is_deleted;

-- ────────────────────────────────────────────────────────────
-- TABLE: milestones  (auto-calculated + custom)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS milestones (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_room_id  UUID        NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    label           VARCHAR(100) NOT NULL,
    target_days     INTEGER     NOT NULL,
    emoji           VARCHAR(10)  DEFAULT '🎯',
    is_custom       BOOLEAN      DEFAULT FALSE,
    is_celebrated   BOOLEAN      DEFAULT FALSE,
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX idx_milestones_room ON milestones(couple_room_id);

-- ────────────────────────────────────────────────────────────
-- FUNCTION: auto-update updated_at
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_couple_rooms_updated_at
    BEFORE UPDATE ON couple_rooms
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_wish_items_updated_at
    BEFORE UPDATE ON wish_items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ────────────────────────────────────────────────────────────
-- DEFAULT MILESTONES (inserted on couple room creation)
-- ────────────────────────────────────────────────────────────
-- These are inserted per-room by the application layer, not here.
-- See: couple.controller.js → createRoom()

-- ────────────────────────────────────────────────────────────
-- VIEW: active_couple_rooms (convenience)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW active_couple_rooms AS
SELECT
    cr.*,
    ua.display_name AS user_a_name,
    ua.photo_url    AS user_a_photo,
    ub.display_name AS user_b_name,
    ub.photo_url    AS user_b_photo,
    CURRENT_DATE - cr.start_date AS days_together
FROM couple_rooms cr
JOIN users ua ON cr.user_a_id = ua.id
LEFT JOIN users ub ON cr.user_b_id = ub.id
WHERE cr.status = 'active';

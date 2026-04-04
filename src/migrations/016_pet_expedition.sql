-- ═══════════════════════════════════════════════════════════════
--  016 – Pet Expedition (Viễn Chinh) System
--  Idle-game mode: send pet on timed adventures for random loot
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pet_expeditions (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_room_id  UUID        NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    expedition_type VARCHAR(32) NOT NULL DEFAULT 'forest',
    duration_hours  INT         NOT NULL DEFAULT 4 CHECK (duration_hours IN (4, 6, 8)),
    status          VARCHAR(16) NOT NULL DEFAULT 'exploring'
                    CHECK (status IN ('exploring', 'returned', 'collected')),
    loot_data       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at         TIMESTAMPTZ NOT NULL,
    collected_at    TIMESTAMPTZ,
    started_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pet_expedition_room_status
    ON pet_expeditions (couple_room_id, status);

CREATE INDEX IF NOT EXISTS idx_pet_expedition_ends_at
    ON pet_expeditions (ends_at) WHERE status = 'exploring';

-- ═══════════════════════════════════════════════════════════════
--  015 – Love Coin reward ledger
--  Idempotent reward tracking + daily cap support
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS coin_reward_logs (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    couple_room_id  UUID        NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    reward_type     VARCHAR(64) NOT NULL,
    reward_key      VARCHAR(128) NOT NULL,
    coins_awarded   INT         NOT NULL CHECK (coins_awarded > 0),
    awarded_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (couple_room_id, reward_type, reward_key)
);

CREATE INDEX IF NOT EXISTS idx_coin_reward_logs_room_created
    ON coin_reward_logs (couple_room_id, created_at DESC);
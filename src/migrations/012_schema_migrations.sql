-- ═══════════════════════════════════════════════════════════════
--  Migration tracking table
--  Records which SQL migration files have been applied.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     VARCHAR(255) PRIMARY KEY,
    applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

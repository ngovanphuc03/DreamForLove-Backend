-- 010: Audit Logs — persist important user actions to DB for traceability
-- Ghi lại các hành động quan trọng (delete account, disconnect, pairing, heartbeat, ...)

CREATE TABLE IF NOT EXISTS audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event           TEXT NOT NULL,                       -- e.g. 'account_deleted', 'couple_paired', 'api_mutation'
    method          TEXT,                                -- HTTP method: POST, PATCH, DELETE
    path            TEXT,                                -- e.g. '/api/couple/heartbeat'
    status_code     INT,
    duration_ms     INT,
    firebase_uid    TEXT,
    user_id         UUID,
    couple_room_id  UUID,
    ip              TEXT,
    request_id      TEXT,
    metadata        JSONB DEFAULT '{}',                  -- Extra context (e.g. partner_id, action details)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying by user
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);

-- Index for querying by time range  
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- Index for querying by event type
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event);

-- Auto-cleanup: partition-ready. For now, a cron job can delete old entries.

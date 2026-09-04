-- TABLE: love_doodles
-- Stores hand-drawn doodles, mini notes, and co-op chain drawings between couples.

CREATE TABLE IF NOT EXISTS love_doodles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    couple_room_id UUID NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_name VARCHAR(100),
    strokes_data JSONB NOT NULL DEFAULT '[]'::jsonb,
    image_base64 TEXT,
    is_chain BOOLEAN NOT NULL DEFAULT false,
    parent_doodle_id UUID REFERENCES love_doodles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_love_doodles_room_created 
    ON love_doodles(couple_room_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_love_doodles_parent 
    ON love_doodles(parent_doodle_id);

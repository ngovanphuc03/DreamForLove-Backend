-- Migration 029: Add secret love note to couple_rooms and packing_list to trip_plans

-- 1. Couple Rooms Secret Love Note
ALTER TABLE couple_rooms ADD COLUMN IF NOT EXISTS secret_love_note TEXT;
ALTER TABLE couple_rooms ADD COLUMN IF NOT EXISTS secret_love_note_updated_at TIMESTAMPTZ;
ALTER TABLE couple_rooms ADD COLUMN IF NOT EXISTS secret_love_note_author_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- 2. Trip Plans Packing Checklist
ALTER TABLE trip_plans ADD COLUMN IF NOT EXISTS packing_list JSONB DEFAULT '[]'::jsonb;

-- 003_performance_indexes.sql
-- Performance-focused composite indexes for high-traffic queries.

-- Faster wishlist listing/filter/sort per room.
CREATE INDEX IF NOT EXISTS idx_wish_items_room_deleted_created
    ON wish_items (couple_room_id, created_at DESC, id DESC)
    WHERE is_deleted = FALSE;

-- Faster food spin/list filtering per room with eaten-state checks.
CREATE INDEX IF NOT EXISTS idx_food_items_room_deleted_eaten_last_created
    ON food_items (couple_room_id, is_eaten, last_eaten_at, created_at DESC, id DESC)
    WHERE is_deleted = FALSE;

-- Faster active pairing code resolution by code + expiry window.
CREATE INDEX IF NOT EXISTS idx_pairing_codes_active_lookup
    ON pairing_codes (code, expires_at DESC)
    WHERE used = FALSE;

-- Faster lookup of active couple room by either participant.
CREATE INDEX IF NOT EXISTS idx_couple_rooms_active_user_a
    ON couple_rooms (user_a_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_couple_rooms_active_user_b
    ON couple_rooms (user_b_id)
    WHERE status = 'active';

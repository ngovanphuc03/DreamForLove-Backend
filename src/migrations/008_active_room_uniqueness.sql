-- 008_active_room_uniqueness.sql
-- Enforce at-most-one active couple room per user side.
-- If legacy duplicate active data exists, skip index creation safely.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM couple_rooms
        WHERE status = 'active'
        GROUP BY user_a_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE NOTICE 'Skip ux_couple_rooms_active_user_a: duplicate active user_a_id exists';
    ELSIF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'ux_couple_rooms_active_user_a'
    ) THEN
        EXECUTE 'CREATE UNIQUE INDEX ux_couple_rooms_active_user_a
                 ON couple_rooms (user_a_id)
                 WHERE status = ''active''';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM couple_rooms
        WHERE status = 'active'
          AND user_b_id IS NOT NULL
        GROUP BY user_b_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE NOTICE 'Skip ux_couple_rooms_active_user_b: duplicate active user_b_id exists';
    ELSIF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'ux_couple_rooms_active_user_b'
    ) THEN
        EXECUTE 'CREATE UNIQUE INDEX ux_couple_rooms_active_user_b
                 ON couple_rooms (user_b_id)
                 WHERE status = ''active'' AND user_b_id IS NOT NULL';
    END IF;
END $$;

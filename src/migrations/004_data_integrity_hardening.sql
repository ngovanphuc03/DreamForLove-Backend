-- 004_data_integrity_hardening.sql
-- Add database-level integrity constraints in an idempotent way.

DO $$
BEGIN
    -- wish_items.price must be non-negative.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_wish_items_price_non_negative'
    ) THEN
        ALTER TABLE wish_items
            ADD CONSTRAINT chk_wish_items_price_non_negative
            CHECK (price >= 0) NOT VALID;
    END IF;
END $$;

DO $$
BEGIN
    -- milestones.target_days must be positive.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_milestones_target_days_positive'
    ) THEN
        ALTER TABLE milestones
            ADD CONSTRAINT chk_milestones_target_days_positive
            CHECK (target_days > 0) NOT VALID;
    END IF;
END $$;

DO $$
BEGIN
    -- pairing code must be exactly 6 digits.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_pairing_codes_code_6_digits'
    ) THEN
        ALTER TABLE pairing_codes
            ADD CONSTRAINT chk_pairing_codes_code_6_digits
            CHECK (code ~ '^[0-9]{6}$') NOT VALID;
    END IF;
END $$;

-- Validate constraints for existing data.
ALTER TABLE wish_items VALIDATE CONSTRAINT chk_wish_items_price_non_negative;
ALTER TABLE milestones VALIDATE CONSTRAINT chk_milestones_target_days_positive;
ALTER TABLE pairing_codes VALIDATE CONSTRAINT chk_pairing_codes_code_6_digits;

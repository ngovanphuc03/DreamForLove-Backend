-- ═══════════════════════════════════════════════════════════════
--  018 – Pet Personality & Skill state
--  Adds persistent fields for personality skill cooldown tracking
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE couple_pet
    ADD COLUMN IF NOT EXISTS personality_skill_last_triggered_at TIMESTAMPTZ;

ALTER TABLE couple_pet
    ADD COLUMN IF NOT EXISTS personality_signature_seed VARCHAR(64);

UPDATE couple_pet
SET personality_signature_seed = SUBSTRING(md5(couple_room_id::text) FOR 12)
WHERE personality_signature_seed IS NULL
   OR personality_signature_seed = '';

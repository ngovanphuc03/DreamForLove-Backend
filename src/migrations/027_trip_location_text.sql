-- 027_trip_location_text.sql: Expand location column to TEXT for exact Google Maps URLs and coordinates
ALTER TABLE trip_plans ALTER COLUMN location TYPE TEXT;

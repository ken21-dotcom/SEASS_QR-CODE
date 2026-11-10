-- Migration 035: Drop sanction recommendations table
-- Removes the deprecated "recommend sanction" feature to allow direct sanction creation

-- Remove dependency in sanction_records
ALTER TABLE sanction_records DROP FOREIGN KEY fk_sanction_recommendation;
ALTER TABLE sanction_records DROP COLUMN recommendation_id;

DROP TABLE IF EXISTS sanction_recommendations;
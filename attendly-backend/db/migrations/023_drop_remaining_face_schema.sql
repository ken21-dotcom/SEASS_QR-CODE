-- 023_drop_remaining_face_schema.sql
-- Phase 4: final zero-face cleanup. Migration 022 removed the enrollment
-- store; this removes the last facial-recognition schema objects:
--   * attendance_records.face_verification_id (foreign key + column)
--   * face_verifications
--   * biometric_consent_policy_versions
--   * biometric_consent_policy
--
-- Run after 022. Idempotent: IF EXISTS guards every statement.

-- The column cannot be dropped while its foreign key exists, so remove the
-- constraint first. Both clauses are MariaDB idempotent forms.
ALTER TABLE attendance_records
  DROP FOREIGN KEY IF EXISTS fk_att_face_verification;

ALTER TABLE attendance_records
  DROP COLUMN IF EXISTS face_verification_id;

DROP TABLE IF EXISTS face_verifications;
DROP TABLE IF EXISTS biometric_consent_policy_versions;
DROP TABLE IF EXISTS biometric_consent_policy;

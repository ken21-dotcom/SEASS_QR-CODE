-- 022_drop_face_tables.sql
-- Phase 4: remove the facial-enrollment store — the encrypted enrollment
-- table, its audit trail and the students.face_enrolled flag. The kiosk now
-- records attendance through dynamic student QR codes (see
-- 020_user_qr_token.sql / 021_attendance_qr_method.sql), so these are dead
-- weight. The legacy face_verifications table and
-- attendance_records.face_verification_id are removed by
-- 023_drop_remaining_face_schema.sql. The verification_method ENUM
-- keeps 'face' as a legacy value for rows recorded before the QR pivot; it is
-- not dropped because the ENUM has no ALTER DROP VALUE in MySQL 8.
--
-- Run after 021. Idempotent: IF EXISTS guards every statement.

DROP TABLE IF EXISTS face_enrollment_audit;
DROP TABLE IF EXISTS face_enrollments;

ALTER TABLE students
  DROP COLUMN IF EXISTS face_enrolled;
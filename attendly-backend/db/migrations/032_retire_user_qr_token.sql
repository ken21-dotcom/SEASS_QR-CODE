-- Migration 032: retire permanent per-user QR tokens
--
-- Check-in codes are now stateless HMAC tokens scoped to one student/event
-- pair (see src/QrToken.php). No token table is needed because the signature
-- itself proves the student and event. Dropping the old column removes the
-- long-lived credential at rest and invalidates screenshots of legacy codes.

ALTER TABLE users
  DROP INDEX idx_users_qr_token,
  DROP COLUMN qr_token;

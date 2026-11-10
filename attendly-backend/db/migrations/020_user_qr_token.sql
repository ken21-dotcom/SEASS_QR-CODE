-- Migration 020: per-student check-in QR token
--
-- Pivots the kiosk from O(N) facial recognition to an O(1) QR scan.
-- Each student receives one cryptographically random, URL-safe token that
-- the kiosk reads and maps back to a user row through the unique index.
--
-- The column is NULLABLE because existing accounts predate this feature;
-- only accounts created or re-tokenised after the migration carry a value.
-- The unique index guarantees one token maps to at most one active student.

ALTER TABLE users
  ADD COLUMN qr_token VARCHAR(64) NULL,
  ADD UNIQUE INDEX idx_users_qr_token (qr_token);
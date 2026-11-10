-- Migration 021: record the QR check-in method
--
-- The kiosk pivoted from facial recognition to QR scanning, so attendance
-- rows created by a QR scan need a distinct verification_method value.
-- The enum gains 'qr' while keeping 'face' and 'manual' so historical rows
-- and the legacy manual-fallback path stay readable.

ALTER TABLE attendance_records
  MODIFY COLUMN verification_method ENUM('face', 'manual', 'qr') NOT NULL;
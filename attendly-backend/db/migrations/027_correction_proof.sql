-- Migration 027: proof of attendance for correction requests
--
-- Students previously submitted a reason with no evidence. Proof is stored as
-- a self-contained data URL (resized client-side to a JPEG/PNG/WebP under the
-- API limit), so no extra upload directory or public file permissions are
-- needed. Existing requests keep NULL and are shown as legacy/no-proof rows.

ALTER TABLE attendance_correction_requests
    ADD COLUMN proof_image MEDIUMTEXT NULL AFTER reason;

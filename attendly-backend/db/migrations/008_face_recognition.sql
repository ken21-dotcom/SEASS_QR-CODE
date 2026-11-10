-- Migration 008: face recognition
-- Replaces the fingerprint schema with webcam face descriptors.
--
-- A descriptor is a 128-float embedding produced by face-api.js. It is a
-- biometric template, not a photo: the camera frames are never stored.
--
-- Existing fingerprint rows cannot be reused for face matching, so the
-- enrollment table is cleared and every student is marked unenrolled.

-- ─── students ───────────────────────────────────────────────────
UPDATE students SET fingerprint_enrolled = FALSE;
ALTER TABLE students CHANGE fingerprint_enrolled face_enrolled BOOLEAN DEFAULT FALSE;

-- ─── fingerprint_enrollments → face_enrollments ─────────────────
DELETE FROM fingerprint_enrollments;
RENAME TABLE fingerprint_enrollments TO face_enrollments;

ALTER TABLE face_enrollments
    CHANGE device_reference descriptor_set JSON NOT NULL
        COMMENT 'Array of 128-float face descriptors — biometric templates, never images',
    ADD COLUMN quality ENUM('excellent','good','poor') NOT NULL DEFAULT 'good' AFTER descriptor_set,
    ADD COLUMN sample_count TINYINT UNSIGNED NOT NULL DEFAULT 3 AFTER quality,
    ADD COLUMN match_threshold DECIMAL(4,3) NOT NULL DEFAULT 0.520 AFTER sample_count,
    ADD COLUMN status ENUM('enrolled','needs-reenrollment') NOT NULL DEFAULT 'enrolled' AFTER is_active;

ALTER TABLE face_enrollments
    DROP INDEX idx_fp_student,
    ADD INDEX idx_face_student (student_id);

-- ─── biometric_verifications → face_verifications ───────────────
-- Widen the enum first: 'face' does not exist yet, so the UPDATE below
-- would be rejected by a strict server if the column still excluded it.
ALTER TABLE biometric_verifications
    MODIFY verification_method ENUM('fingerprint','face','manual') NOT NULL;

UPDATE biometric_verifications SET verification_method = 'face'
    WHERE verification_method = 'fingerprint';

ALTER TABLE biometric_verifications
    MODIFY verification_method ENUM('face','manual') NOT NULL;

RENAME TABLE biometric_verifications TO face_verifications;
ALTER TABLE face_verifications
    DROP INDEX idx_verif_student,
    ADD INDEX idx_face_verif_student (student_id);

-- ─── attendance_records ────────────────────────────────────────
-- The foreign key references the verification row, so drop it before
-- renaming that column and recreate it under the new name.
ALTER TABLE attendance_records DROP FOREIGN KEY fk_att_verification;

ALTER TABLE attendance_records
    MODIFY verification_method ENUM('fingerprint','face','manual') NOT NULL;

UPDATE attendance_records SET verification_method = 'face'
    WHERE verification_method = 'fingerprint';

ALTER TABLE attendance_records
    MODIFY verification_method ENUM('face','manual') NOT NULL,
    CHANGE biometric_verification_id face_verification_id INT UNSIGNED NULL;

ALTER TABLE attendance_records
    ADD CONSTRAINT fk_att_face_verification
        FOREIGN KEY (face_verification_id)
        REFERENCES face_verifications(id) ON DELETE SET NULL;

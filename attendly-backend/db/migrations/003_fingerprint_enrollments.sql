-- Migration 003: fingerprint_enrollments
-- Each row = one enrollment event (doubles as audit trail).
-- device_reference is an opaque SDK pointer — never raw biometric data.

CREATE TABLE IF NOT EXISTS fingerprint_enrollments (
    id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    student_id       INT UNSIGNED NOT NULL,
    device_reference VARCHAR(255) NOT NULL COMMENT 'Opaque SDK template pointer — never raw biometric data',
    enrolled_by      INT UNSIGNED NOT NULL,
    enrolled_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active        BOOLEAN DEFAULT TRUE,
    CONSTRAINT fk_fp_student
        FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_fp_enrolled_by
        FOREIGN KEY (enrolled_by) REFERENCES administrators(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_fp_student ON fingerprint_enrollments (student_id);

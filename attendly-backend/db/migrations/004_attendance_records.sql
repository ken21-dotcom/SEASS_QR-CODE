-- Migration 004: biometric_verifications + attendance_records

-- ─── biometric_verifications ────────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_verifications (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    token               CHAR(64)            NOT NULL,
    student_id          INT UNSIGNED        NOT NULL,
    expires_at          TIMESTAMP           NOT NULL,
    consumed_at         TIMESTAMP NULL,
    verification_method ENUM('fingerprint','manual') NOT NULL,
    created_by          INT UNSIGNED        NOT NULL,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_verification_token
        UNIQUE (token),
    CONSTRAINT fk_verif_student
        FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_verif_creator
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_verif_student ON biometric_verifications (student_id);

-- ─── attendance_records ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance_records (
    id                        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_id                  INT UNSIGNED NOT NULL,
    student_id                INT UNSIGNED NOT NULL,
    check_in_time             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    verification_method       ENUM('fingerprint','manual') NOT NULL,
    biometric_verification_id INT UNSIGNED NULL,
    CONSTRAINT fk_att_event
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE RESTRICT,
    CONSTRAINT fk_att_student
        FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_att_verification
        FOREIGN KEY (biometric_verification_id)
        REFERENCES biometric_verifications(id) ON DELETE SET NULL,
    -- Real constraint: one check-in per student per event.
    -- Duplicate check-in is rejected by MySQL (ER_DUP_ENTRY → 409),
    -- never by an app-level SELECT.
    CONSTRAINT uq_attendance_event_student
        UNIQUE (event_id, student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_att_student ON attendance_records (student_id);
CREATE INDEX idx_att_event   ON attendance_records (event_id);
-- Student attendance corrections, biometric consent policy, and shared kiosk stations.

CREATE TABLE IF NOT EXISTS attendance_correction_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    student_id INT UNSIGNED NOT NULL,
    event_id INT UNSIGNED NOT NULL,
    requested_check_in_time DATETIME NOT NULL,
    reason TEXT NOT NULL,
    status ENUM('pending','approved','denied') NOT NULL DEFAULT 'pending',
    reviewed_by INT UNSIGNED NULL,
    reviewed_at DATETIME NULL,
    review_notes TEXT NULL,
    previous_check_in_time DATETIME NULL,
    applied_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_attendance_correction_student (student_id, created_at),
    INDEX idx_attendance_correction_status (status, created_at),
    CONSTRAINT fk_attendance_correction_student FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_attendance_correction_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE RESTRICT,
    CONSTRAINT fk_attendance_correction_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biometric_consent_policy (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    version VARCHAR(32) NOT NULL,
    policy_text TEXT NOT NULL,
    published_at DATETIME NULL,
    updated_by INT UNSIGNED NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_biometric_consent_policy_singleton CHECK (id = 1),
    CONSTRAINT fk_biometric_consent_policy_editor FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biometric_consent_policy_versions (
    version VARCHAR(32) NOT NULL PRIMARY KEY,
    policy_text TEXT NOT NULL,
    published_at DATETIME NOT NULL,
    updated_by INT UNSIGNED NULL,
    CONSTRAINT fk_biometric_policy_version_editor FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO biometric_consent_policy (id, version, policy_text, published_at, updated_by)
VALUES (1, 'unpublished', '', NULL, NULL)
ON DUPLICATE KEY UPDATE id = VALUES(id);

CREATE TABLE IF NOT EXISTS kiosk_stations (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    device VARCHAR(100) NULL,
    location VARCHAR(150) NULL,
    last_seen_at DATETIME NULL,
    created_by INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_kiosk_station_last_seen (last_seen_at),
    CONSTRAINT fk_kiosk_station_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

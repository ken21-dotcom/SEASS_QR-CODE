-- Migration 005: sanctions
-- Thresholds → student_standing (cached recompute) → recommendations → records.

-- ─── sanction_thresholds ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sanction_thresholds (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    min_absences  INT NOT NULL,
    max_absences  INT NULL,
    standing_label VARCHAR(100) NOT NULL,
    configured_by INT UNSIGNED NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_threshold_range
        CHECK (min_absences >= 0 AND (max_absences IS NULL OR max_absences >= min_absences)),
    CONSTRAINT fk_threshold_admin
        FOREIGN KEY (configured_by) REFERENCES administrators(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── student_standing ───────────────────────────────────────────
-- Derived & cached ONLY. The recompute service is the sole writer.
CREATE TABLE IF NOT EXISTS student_standing (
    student_id       INT UNSIGNED PRIMARY KEY,
    absence_count    INT NOT NULL DEFAULT 0,
    current_standing VARCHAR(100) NOT NULL,
    last_computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_standing_student
        FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── sanction_recommendations ───────────────────────────────────
CREATE TABLE IF NOT EXISTS sanction_recommendations (
    id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    student_id           INT UNSIGNED NOT NULL,
    recommended_by       INT UNSIGNED NOT NULL,
    reason               TEXT NOT NULL,
    severity             ENUM('low','medium','high') DEFAULT 'medium',
    related_absence_count INT NOT NULL DEFAULT 0,
    status               ENUM('pending','finalized','overridden') DEFAULT 'pending',
    decision_notes       TEXT NULL,
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_rec_student
        FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_rec_officer
        FOREIGN KEY (recommended_by) REFERENCES ssc_officers(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_rec_student ON sanction_recommendations (student_id);
CREATE INDEX idx_rec_status  ON sanction_recommendations (status);

-- ─── sanction_records ───────────────────────────────────────────
-- Created ONLY inside the admin finalize flow.
-- UNIQUE(recommendation_id) prevents double-finalizing one recommendation.
CREATE TABLE IF NOT EXISTS sanction_records (
    id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    recommendation_id INT UNSIGNED NULL,
    student_id       INT UNSIGNED NOT NULL,
    type             ENUM('warning','probation') NOT NULL,
    decided_by       INT UNSIGNED NOT NULL,
    decision_notes   TEXT NULL,
    decided_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    lifted_at        TIMESTAMP NULL,
    CONSTRAINT uq_sanction_recommendation
        UNIQUE (recommendation_id),
    CONSTRAINT fk_sanction_recommendation
        FOREIGN KEY (recommendation_id)
        REFERENCES sanction_recommendations(id) ON DELETE SET NULL,
    CONSTRAINT fk_sanction_student
        FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_sanction_decided_by
        FOREIGN KEY (decided_by) REFERENCES administrators(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_sanction_student ON sanction_records (student_id);
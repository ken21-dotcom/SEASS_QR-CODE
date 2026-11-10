-- Student appeals and face re-enrollment requests.
CREATE TABLE IF NOT EXISTS student_appeals (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    student_id INT UNSIGNED NOT NULL,
    sanction_id INT UNSIGNED NOT NULL,
    reason TEXT NOT NULL,
    status ENUM('pending','approved','denied') NOT NULL DEFAULT 'pending',
    reviewed_by INT UNSIGNED NULL,
    reviewed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_appeal_student (student_id, created_at),
    INDEX idx_appeal_status (status, created_at),
    CONSTRAINT fk_appeal_student FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_appeal_sanction FOREIGN KEY (sanction_id) REFERENCES sanction_records(id) ON DELETE CASCADE,
    CONSTRAINT fk_appeal_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reenrollment_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    student_id INT UNSIGNED NOT NULL,
    reason TEXT NOT NULL,
    status ENUM('pending','approved','denied') NOT NULL DEFAULT 'pending',
    reviewed_by INT UNSIGNED NULL,
    reviewed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_reenroll_student (student_id, created_at),
    INDEX idx_reenroll_status (status, created_at),
    CONSTRAINT fk_reenroll_student FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_reenroll_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

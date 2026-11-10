-- Migration 001: users, administrators, ssc_officers, students

CREATE TABLE IF NOT EXISTS users (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    role          ENUM('student','ssc_officer','administrator') NOT NULL,
    username      VARCHAR(50)  NOT NULL,
    email         VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    status        ENUM('active','inactive') DEFAULT 'active',
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE UNIQUE INDEX idx_users_username ON users (username);
CREATE UNIQUE INDEX idx_users_email    ON users (email);

-- ─── administrators ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS administrators (
    user_id INT UNSIGNED PRIMARY KEY,
    CONSTRAINT fk_admin_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── ssc_officers ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ssc_officers (
    user_id     INT UNSIGNED PRIMARY KEY,
    position    VARCHAR(100) NOT NULL,
    approved_by INT UNSIGNED NULL,
    approved_at TIMESTAMP NULL,
    status      ENUM('pending','approved','deactivated') DEFAULT 'pending',
    CONSTRAINT fk_officer_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_officer_approved_by
        FOREIGN KEY (approved_by) REFERENCES administrators(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── students ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS students (
    user_id              INT UNSIGNED PRIMARY KEY,
    student_id_number    VARCHAR(30)  NOT NULL,
    first_name           VARCHAR(100) NOT NULL,
    last_name            VARCHAR(100) NOT NULL,
    program              VARCHAR(100) NOT NULL,
    year_level           VARCHAR(20)  NOT NULL,
    section              VARCHAR(30)  NOT NULL,
    fingerprint_enrolled BOOLEAN DEFAULT FALSE,
    CONSTRAINT fk_student_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT uq_student_id_number
        UNIQUE (student_id_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

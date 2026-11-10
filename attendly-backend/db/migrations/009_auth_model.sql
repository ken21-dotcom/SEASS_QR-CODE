-- Migration 009: auth model and student approval

UPDATE users SET status = 'active' WHERE status IS NULL;

ALTER TABLE users
    MODIFY COLUMN status ENUM('pending','active','inactive') NOT NULL DEFAULT 'pending',
    ADD COLUMN display_name VARCHAR(150) NULL AFTER email,
    ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE AFTER status,
    ADD INDEX idx_users_status (status),
    ADD INDEX idx_users_role (role);

ALTER TABLE students
    ADD COLUMN department VARCHAR(100) NOT NULL DEFAULT 'Unassigned' AFTER last_name,
    ADD COLUMN approved_by INT UNSIGNED NULL AFTER face_enrolled,
    ADD COLUMN approved_at TIMESTAMP NULL DEFAULT NULL AFTER approved_by,
    ADD INDEX idx_students_approved_by (approved_by),
    ADD CONSTRAINT fk_students_approved_by
        FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;

UPDATE users u
LEFT JOIN students s ON s.user_id = u.id
SET u.display_name = CASE
    WHEN u.role = 'student'
        THEN NULLIF(TRIM(CONCAT(COALESCE(s.first_name, ''), ' ', COALESCE(s.last_name, ''))), '')
    ELSE u.username
END;

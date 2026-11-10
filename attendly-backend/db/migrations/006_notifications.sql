-- Migration 006: notifications

CREATE TABLE IF NOT EXISTS notifications (
    id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id            INT UNSIGNED NOT NULL,
    type               VARCHAR(50) NOT NULL,
    message            TEXT NOT NULL,
    related_entity_type VARCHAR(50) NULL,
    related_entity_id  INT NULL,
    is_read            BOOLEAN DEFAULT FALSE,
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notif_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_notif_user_read_date
    ON notifications (user_id, is_read, created_at);
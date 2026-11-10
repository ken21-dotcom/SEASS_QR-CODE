-- Migration 002: events

CREATE TABLE IF NOT EXISTS events (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(150) NOT NULL,
    description TEXT NULL,
    event_date  DATE         NOT NULL,
    start_time  TIME         NOT NULL,
    end_time    TIME         NOT NULL,
    venue       VARCHAR(150) NOT NULL,
    event_type  ENUM('mandatory','optional') DEFAULT 'mandatory',
    status      ENUM('scheduled','cancelled','completed') DEFAULT 'scheduled',
    created_by  INT UNSIGNED NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_event_creator
        FOREIGN KEY (created_by) REFERENCES ssc_officers(user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_events_created_by  ON events (created_by);
CREATE INDEX idx_events_status_date ON events (status, event_date);

-- Migration 030: Audit Logs
-- Immutable append-only log of all CUD operations on core entities.
-- Written by Repository::writeAudit() after every create/update/delete.

CREATE TABLE IF NOT EXISTS audit_logs (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id        INT UNSIGNED NULL,
    action         ENUM('create','update','delete') NOT NULL,
    table_name     VARCHAR(64) NOT NULL,
    record_id      BIGINT UNSIGNED NOT NULL,
    old_values     JSON NULL,
    new_values     JSON NULL,
    ip_address     VARCHAR(45) NULL,
    user_agent     TEXT NULL,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_table_record (table_name, record_id),
    INDEX idx_audit_user (user_id),
    INDEX idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
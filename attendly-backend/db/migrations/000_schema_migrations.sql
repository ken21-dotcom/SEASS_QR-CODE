-- Migration 000: schema_migrations (tracks applied migrations)
-- This table is created first; the migrate.php runner reads it.

CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    filename   VARCHAR(255) NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_migrations_filename
    ON schema_migrations (filename);

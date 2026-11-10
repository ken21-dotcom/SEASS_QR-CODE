-- Migration 007: sessions
-- Optional DB-backed session store (complements native PHP $_SESSION).
-- PHP's native file-based sessions are the default; this table reserves
-- the schema for a DB-backed handler later.

CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(128) NOT NULL PRIMARY KEY
        COLLATE utf8mb4_bin,
    expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    data       MEDIUMTEXT NULL
        COLLATE utf8mb4_bin
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_sessions_expires ON sessions (expires_at);
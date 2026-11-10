-- Migration 017: email is the account identifier; remove the redundant username.

CREATE OR REPLACE SQL SECURITY INVOKER VIEW administrator_details AS
SELECT
    u.id AS user_id,
    u.email,
    u.display_name,
    u.status,
    u.created_at,
    u.updated_at
FROM administrators a
JOIN users u ON u.id = a.user_id;

ALTER TABLE users
    DROP INDEX idx_users_username,
    DROP COLUMN username;

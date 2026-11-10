-- Keep administrator-specific membership normalized in administrators,
-- while exposing the linked account details for database browsing/reporting.
CREATE OR REPLACE SQL SECURITY INVOKER VIEW administrator_details AS
SELECT
    u.id AS user_id,
    u.username,
    u.email,
    u.display_name,
    u.status,
    u.created_at,
    u.updated_at
FROM administrators a
JOIN users u ON u.id = a.user_id;

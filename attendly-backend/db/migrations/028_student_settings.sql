-- Migration 028: student profile & account settings
--
-- The student profile page now manages contact details, notification
-- preferences, and account status. Each new column is nullable so existing
-- rows keep working without a backfill pass:
--   * contact_number            - direct phone contact, optional
--   * last_password_change      - when the password was last rotated
--   * notification_preferences  - JSON object of opt-in toggles

ALTER TABLE users
    ADD COLUMN contact_number VARCHAR(20) NULL AFTER email,
    ADD COLUMN last_password_change TIMESTAMP NULL AFTER contact_number,
    ADD COLUMN notification_preferences JSON NULL AFTER last_password_change;
-- Migration 031: synchronous email OTP for student sign-up
--
-- The sign-up flow now verifies the applicant's email with a 6-digit
-- one-time code sent through the external Email API before the account
-- reaches the administrator approval queue. The code and its expiry are
-- stored on the user row so verification is a simple lookup.
--
-- Both columns are nullable: existing accounts predate this feature and
-- simply have no pending code.

ALTER TABLE users
    ADD COLUMN email_otp VARCHAR(6) NULL AFTER notification_preferences,
    ADD COLUMN otp_expires_at TIMESTAMP NULL AFTER email_otp;
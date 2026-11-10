-- Migration 018: event check-out windows
--
-- An event can have two separate attendance windows:
--   * check-in  — controlled by the existing tunables, anchored to start_time
--   * check-out — anchored to end_time, configured per event
--
-- checkout_open_minutes  : minutes BEFORE end_time that check-out opens
-- checkout_close_minutes : minutes AFTER  end_time that check-out closes
--
-- Example: an event ending at 21:30 with open=60, close=0 accepts
-- check-out scans from 20:30 until 21:30.

ALTER TABLE attendance_records
    ADD COLUMN check_out_time TIMESTAMP NULL DEFAULT NULL AFTER check_in_time;

ALTER TABLE events
    ADD COLUMN checkout_open_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 60
        COMMENT 'Minutes before end_time when check-out opens'
        AFTER end_time,
    ADD COLUMN checkout_close_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 60
        COMMENT 'Minutes after end_time when check-out closes'
        AFTER checkout_open_minutes;

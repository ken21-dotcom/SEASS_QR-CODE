-- Migration 038: attendance_type column on events + scan_number on attendance_records
-- Controls how many kiosk scans a student needs per event.
--  'single'     = 1 scan  (attendance only)
--  'in_out'     = 2 scans (time in, then time out)
--  'four_point' = 4 scans (AM in, AM out, PM in, PM out)
-- Default is 'single' so existing events keep working unchanged.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS attendance_type ENUM('single','in_out','four_point') NOT NULL DEFAULT 'single'
        AFTER target_department;

-- Track progress through the 4-point scan cycle.
-- 0 = legacy row (treated as scan 1 done when first seen by new code).
ALTER TABLE attendance_records
    ADD COLUMN IF NOT EXISTS scan_number TINYINT UNSIGNED NOT NULL DEFAULT 0
        AFTER check_out_time;

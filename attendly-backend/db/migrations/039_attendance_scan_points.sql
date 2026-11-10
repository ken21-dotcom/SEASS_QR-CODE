-- Migration 039: one attendance row per scan point.
--
-- Migration 004 created a unique key on (event_id, student_id), which was
-- correct while an event had exactly one check-in. Migration 038 added
-- four_point events (AM In / AM Out / PM In / PM Out): scans 3 and 4 need a
-- second row, so the key must include scan_number.
--
-- Single and in_out events still keep one row: the application rejects a
-- second check-in before inserting, and their scan_number advances 1 -> 2.

ALTER TABLE attendance_records
    DROP INDEX uq_attendance_event_student,
    ADD UNIQUE KEY uq_attendance_event_student_scan (event_id, student_id, scan_number);

-- The unique (event_id, student_id) index already supports lookups by
-- event_id and satisfies the event foreign key. Keep only that index.
ALTER TABLE attendance_records
    DROP INDEX idx_att_event;

-- Migration 033: event semester and department targeting

ALTER TABLE events
    ADD COLUMN semester ENUM('1st Semester', '2nd Semester', 'Summer', 'N/A')
        NOT NULL DEFAULT 'N/A' AFTER event_category,
    ADD COLUMN target_department VARCHAR(100) NULL DEFAULT NULL AFTER semester;

CREATE INDEX idx_events_target_semester ON events (semester, target_department);

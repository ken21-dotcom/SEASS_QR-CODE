-- Migration 024: public display identifiers
--
-- Keep the INT AUTO_INCREMENT primary keys untouched so every foreign key
-- continues to reference users(id) / events(id). A separate public_id is the
-- human-facing identifier printed in tables, reports and dashboards.
--
-- Existing rows keep their current numeric value, formatted with the role
-- prefix: USR_ for administrators, STUD_ for students, SSC_ for officers and
-- EVNT_ for events.

ALTER TABLE users
    ADD COLUMN public_id VARCHAR(20) NULL AFTER id;

UPDATE users
SET public_id = CONCAT(
    CASE role
        WHEN 'student'     THEN 'STUD'
        WHEN 'ssc_officer' THEN 'SSC'
        ELSE                    'USR'
    END,
    '_',
    LPAD(id, 3, '0')
);

ALTER TABLE users
    MODIFY COLUMN public_id VARCHAR(20) NOT NULL,
    ADD UNIQUE INDEX uq_users_public_id (public_id);

ALTER TABLE events
    ADD COLUMN public_id VARCHAR(20) NULL AFTER id;

UPDATE events
SET public_id = CONCAT('EVNT_', LPAD(id, 3, '0'));

ALTER TABLE events
    MODIFY COLUMN public_id VARCHAR(20) NOT NULL,
    ADD UNIQUE INDEX uq_events_public_id (public_id);

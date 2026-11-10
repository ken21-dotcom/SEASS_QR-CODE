-- Migration 040: events.created_by references users(id).
--
-- Migration 002 pointed this at ssc_officers(user_id), which meant an
-- administrator had no valid row to record as the creator even though the
-- admin Manage Events page exposes the Add Event form. Both administrators
-- and SSC officers are users, so users(id) is the correct parent table.
-- Existing officer ids are already users ids, so no data migration is needed.

ALTER TABLE events
    DROP FOREIGN KEY fk_event_creator;

ALTER TABLE events
    ADD CONSTRAINT fk_event_creator
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;

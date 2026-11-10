-- Migration 026: event category
--
-- event_type answers "is attendance required?" (mandatory/optional).
-- event_category answers "how is the event presented in reports?"
-- (major/minor). A mandatory event can still be a minor one, such as a
-- weekly flag-raising ceremony, so the two concepts are stored separately.
--
-- Existing rows keep their current behaviour: mandatory events become
-- major and optional events become minor. The realistic seed data then
-- refines the demo events (flag raisings are minor + mandatory).

ALTER TABLE events
    ADD COLUMN event_category ENUM('major','minor') NOT NULL DEFAULT 'minor'
        AFTER event_type;

UPDATE events
   SET event_category = CASE
                          WHEN event_type = 'mandatory' THEN 'major'
                          ELSE 'minor'
                        END;

CREATE INDEX idx_events_category_date ON events (event_category, event_date);

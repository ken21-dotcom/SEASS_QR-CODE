-- Migration 037: drop the manual sanction workflow
--
-- Sanctions are now purely mathematical: a student is sanctioned when they
-- exceed 3 absences. There is no Warning / Probation / Suspension scale, no
-- "Status" concept, and no manual "Apply Sanction" workflow. The remaining
-- tables from the old manual model are dead and removed here.

-- sanction_records was the only writer of the old manual sanctions. It is
-- dropped unconditionally; migration 035 already removed its
-- sanction_recommendations dependency, so no FK remains.
DROP TABLE IF EXISTS sanction_records;

-- The threshold/standing tables were derived caches of the same manual
-- model. They are unused by the current schema and code paths.
DROP TABLE IF EXISTS student_standing;
DROP TABLE IF EXISTS sanction_thresholds;
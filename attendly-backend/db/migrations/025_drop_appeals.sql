-- Migration 025: remove the sanction appeal feature.
-- Appeals are no longer part of the product; the frontend and API no longer
-- reference this table.

DROP TABLE IF EXISTS student_appeals;

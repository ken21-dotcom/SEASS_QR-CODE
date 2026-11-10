-- Migration 029: rename students.section to students.block
--
-- "Block" is the term the registrar uses for a student's cohort within a
-- program and year level. Rename the column rather than keeping a display
-- alias so the API, signup form, and student lists all share one name.

ALTER TABLE students
    CHANGE COLUMN section block VARCHAR(30) NOT NULL;

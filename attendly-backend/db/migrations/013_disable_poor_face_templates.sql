-- Do not use low-quality templates for matching.
UPDATE face_enrollments
SET is_active = 0, status = 'needs-reenrollment'
WHERE quality = 'poor';

UPDATE students s
JOIN face_enrollments fe ON fe.student_id = s.user_id
SET s.face_enrolled = 0
WHERE fe.quality = 'poor';

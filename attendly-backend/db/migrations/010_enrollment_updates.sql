DELETE older
FROM face_enrollments AS older
INNER JOIN face_enrollments AS newer
    ON newer.student_id = older.student_id
    AND newer.id > older.id;

ALTER TABLE face_enrollments
    DROP FOREIGN KEY fk_fp_enrolled_by;

ALTER TABLE face_enrollments
    DROP INDEX fk_fp_enrolled_by;

ALTER TABLE face_enrollments
    MODIFY COLUMN enrolled_by INT UNSIGNED NULL,
    MODIFY COLUMN descriptor_set JSON NULL;

ALTER TABLE face_enrollments
    ADD COLUMN descriptor_ciphertext MEDIUMBLOB NULL,
    ADD COLUMN descriptor_nonce VARBINARY(12) NULL,
    ADD COLUMN descriptor_tag VARBINARY(16) NULL,
    ADD COLUMN encryption_key_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    ADD COLUMN consent_given_at DATETIME NULL,
    ADD COLUMN consent_version VARCHAR(32) NULL,
    ADD COLUMN consent_withdrawn_at DATETIME NULL,
    ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

ALTER TABLE face_enrollments
    ADD INDEX idx_face_enrolled_by (enrolled_by),
    ADD CONSTRAINT fk_face_enrolled_by
        FOREIGN KEY (enrolled_by) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE face_enrollments
    DROP INDEX idx_face_student,
    ADD UNIQUE INDEX uq_face_enrollments_student (student_id);

CREATE TABLE IF NOT EXISTS face_enrollment_audit (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    student_id  INT UNSIGNED NOT NULL,
    actor_id    INT UNSIGNED NULL,
    action      ENUM('enrollment', 're-enrollment', 'revocation', 'quality-failure') NOT NULL,
    quality     ENUM('excellent', 'good', 'poor') NULL,
    result      VARCHAR(32) NULL,
    device      VARCHAR(100) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_face_audit_student (student_id, created_at),
    INDEX idx_face_audit_actor (actor_id),
    CONSTRAINT fk_face_audit_student
        FOREIGN KEY (student_id) REFERENCES students (user_id) ON DELETE CASCADE,
    CONSTRAINT fk_face_audit_actor
        FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

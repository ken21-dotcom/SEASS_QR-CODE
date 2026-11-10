-- Support the severity values offered by the sanction review UI.
ALTER TABLE sanction_records
    MODIFY COLUMN type ENUM('warning','probation','suspension') NOT NULL;

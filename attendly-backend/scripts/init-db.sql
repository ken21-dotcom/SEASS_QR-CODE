-- ATTENDLY — Database Provisioning Script
-- Run ONCE as MySQL/MariaDB root (or via phpMyAdmin SQL tab):
--   mysql -u root -p < scripts/init-db.sql
--
-- This creates the application database and a least-privilege user.
-- The application connects as attendly_app, NOT root.

-- Create the database
CREATE DATABASE IF NOT EXISTS attendly_seass_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- Create the application user (XAMPP default: allow from localhost)
CREATE USER IF NOT EXISTS 'attendly_app'@'localhost' IDENTIFIED BY 'attendly_pass';
CREATE USER IF NOT EXISTS 'attendly_app'@'127.0.0.1' IDENTIFIED BY 'attendly_pass';
CREATE USER IF NOT EXISTS 'attendly_app'@'::1' IDENTIFIED BY 'attendly_pass';

-- Separate schema migration account. Change both sample passwords before use.
CREATE USER IF NOT EXISTS 'attendly_migrator'@'localhost' IDENTIFIED BY 'attendly_migrate_pass';
CREATE USER IF NOT EXISTS 'attendly_migrator'@'127.0.0.1' IDENTIFIED BY 'attendly_migrate_pass';
CREATE USER IF NOT EXISTS 'attendly_migrator'@'::1' IDENTIFIED BY 'attendly_migrate_pass';

-- Runtime account: only application data operations.
REVOKE CREATE, ALTER, DROP, REFERENCES, INDEX ON attendly_seass_db.* FROM 'attendly_app'@'localhost';
REVOKE CREATE, ALTER, DROP, REFERENCES, INDEX ON attendly_seass_db.* FROM 'attendly_app'@'127.0.0.1';
REVOKE CREATE, ALTER, DROP, REFERENCES, INDEX ON attendly_seass_db.* FROM 'attendly_app'@'::1';
GRANT SELECT, INSERT, UPDATE, DELETE
  ON attendly_seass_db.*
  TO 'attendly_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE
  ON attendly_seass_db.*
  TO 'attendly_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE
  ON attendly_seass_db.*
  TO 'attendly_app'@'::1';

-- Migration account: schema privileges are not used by the web server.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, REFERENCES, INDEX
  ON attendly_seass_db.* TO 'attendly_migrator'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, REFERENCES, INDEX
  ON attendly_seass_db.* TO 'attendly_migrator'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, REFERENCES, INDEX
  ON attendly_seass_db.* TO 'attendly_migrator'@'::1';

FLUSH PRIVILEGES;

SELECT 'Database, runtime user, and migration user created.' AS result;

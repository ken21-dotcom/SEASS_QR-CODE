<?php
/**
 * ATTENDLY — Defense Reset Script
 *
 * CLI:  php scripts/reset-for-defense.php
 *
 * Creates a completely clean database with exactly 3 test accounts
 * and absolutely no other data (no events, no attendance, no sanctions,
 * no queue jobs).
 *
 * Usage:
 *   php scripts/reset-for-defense.php
 */

declare(strict_types=1);

if (php_sapi_name() !== 'cli' || getenv('APP_ENV') === 'production') {
    die("Forbidden.\n");
}

use Attendly\PublicIdGenerator;

require __DIR__ . '/../config/db.php';
require __DIR__ . '/../config/config.php';
require __DIR__ . '/../src/PublicIdGenerator.php';

$defensePassword = 'password123';

function out(string $message): void
{
    fwrite(STDOUT, $message . PHP_EOL);
}

function err(string $message): void
{
    fwrite(STDERR, $message . PHP_EOL);
}

try {
    out('=== ATTENDLY Defense Reset ===');
    out('');

    // ────────────────────────────────────────────────────────────────
    // 1. MySQL DATABASE WIPE
    // ────────────────────────────────────────────────────────────────
    out('[1/3] Wiping MySQL database...');
    $mysql = get_db();

    // Disable foreign key checks
    $mysql->exec('SET FOREIGN_KEY_CHECKS = 0;');

    // Fetch all BASE TABLES (skip views)
    $tables = $mysql->query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")->fetchAll(PDO::FETCH_COLUMN);

    foreach ($tables as $table) {
        if ($table === 'schema_migrations') {
            out("  - Skipping 'schema_migrations' (preserving migration history)");
            continue;
        }
        $mysql->exec("TRUNCATE TABLE `$table`");
        out("  - Truncated: $table");
    }

    // Re-enable foreign key checks
    $mysql->exec('SET FOREIGN_KEY_CHECKS = 1;');
    out('  MySQL wipe complete.');

    // ────────────────────────────────────────────────────────────────
    // 2. CLEAR SQLITE QUEUE
    // ────────────────────────────────────────────────────────────────
    out('');
    out('[2/3] Clearing SQLite queue...');
    $sqlitePath = __DIR__ . '/../queue.sqlite';
    if (file_exists($sqlitePath)) {
        $sqlite = new PDO('sqlite:' . $sqlitePath);
        $sqlite->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $sqlite->exec('DROP TABLE IF EXISTS job_queue;');
        out('  Dropped job_queue table (will be recreated by worker on next run).');
    } else {
        out('  queue.sqlite not found (worker will create it on first run).');
    }
    out('  SQLite queue clear complete.');

    // ────────────────────────────────────────────────────────────────
    // 3. CREATE THE 3 DEFENSE ACCOUNTS
    // ────────────────────────────────────────────────────────────────
    out('');
    out('[3/3] Creating 3 defense accounts...');

    $hash = password_hash($defensePassword, PASSWORD_DEFAULT);

    // Begin transaction for all inserts
    $mysql->beginTransaction();

    try {
        // ── Admin ───────────────────────────────────────────────
        $adminPublicId = 'USR_001';
        $mysql->prepare(
            'INSERT INTO users
                (public_id, role, email, display_name, password_hash, status, must_change_password)
             VALUES
                (:public_id, \'administrator\', :email, :display_name, :hash, \'active\', 0)'
        )->execute([
            'public_id'    => $adminPublicId,
            'email'        => 'admin@example.com',
            'display_name' => 'System Administrator',
            'hash'         => $hash,
        ]);
        $adminId = (int) $mysql->lastInsertId();

        $mysql->prepare(
            'INSERT INTO administrators (user_id) VALUES (:uid)'
        )->execute(['uid' => $adminId]);

        out("  ✓ Created admin: admin@example.com (Public ID: $adminPublicId)");

        // ── SSC Officer ─────────────────────────────────────────
        $officerPublicId = 'SSC_001';
        $mysql->prepare(
            'INSERT INTO users
                (public_id, role, email, display_name, password_hash, status, must_change_password)
             VALUES
                (:public_id, \'ssc_officer\', :email, :display_name, :hash, \'active\', 0)'
        )->execute([
            'public_id'    => $officerPublicId,
            'email'        => 'officer@example.com',
            'display_name' => 'SSC Officer',
            'hash'         => $hash,
        ]);
        $officerId = (int) $mysql->lastInsertId();

        $mysql->prepare(
            'INSERT INTO ssc_officers
                (user_id, position, approved_by, approved_at, status)
             VALUES
                (:uid, :position, :approved_by, NOW(), \'approved\')'
        )->execute([
            'uid'         => $officerId,
            'position'    => 'Secretary',
            'approved_by' => $adminId,
        ]);

        out("  ✓ Created SSC officer: officer@example.com (Public ID: $officerPublicId)");

        // ── Student ─────────────────────────────────────────────
        $studentPublicId = 'STUD_001';
        $studentIdNumber = '2024-00001';

        $mysql->prepare(
            'INSERT INTO users
                (public_id, role, email, display_name, password_hash, status, must_change_password)
             VALUES
                (:public_id, \'student\', :email, :display_name, :hash, \'active\', 0)'
        )->execute([
            'public_id'    => $studentPublicId,
            'email'        => 'student@example.com',
            'display_name' => 'Test Student',
            'hash'         => $hash,
        ]);
        $studentId = (int) $mysql->lastInsertId();

        $mysql->prepare(
            'INSERT INTO students
                (user_id, student_id_number, first_name, last_name, department,
                 program, year_level, block)
             VALUES
                (:uid, :idnum, :first, :last, :department,
                 :program, :year, :block)'
        )->execute([
            'uid'        => $studentId,
            'idnum'      => $studentIdNumber,
            'first'      => 'Test',
            'last'       => 'Student',
            'department' => 'School of Computer Studies',
            'program'    => 'BSIT',
            'year'       => '3',
            'block'      => 'A',
        ]);

        out("  ✓ Created student: student@example.com (Public ID: $studentPublicId)");

        $mysql->commit();
    } catch (Throwable $e) {
        if ($mysql->inTransaction()) {
            $mysql->rollBack();
        }
        throw $e;
    }

    out('');
    out('=== DEFENSE RESET COMPLETE ===');
    out('');
    out('Database state:');
    out('  • MySQL: All tables truncated (except schema_migrations)');
    out('  • SQLite: job_queue dropped (fresh on next worker start)');
    out('  • Admin account created.');
    out('  • SSC account created.');
    out('  • Student account created.');
    out('');
    out('All accounts use password: password123');
    out('Ready for defense demonstration.');

} catch (Throwable $e) {
    err('');
    err('ERROR: ' . $e->getMessage());
    err($e->getTraceAsString());
    exit(1);
}
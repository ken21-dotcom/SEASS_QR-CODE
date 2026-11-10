<?php
/**
 * ATTENDLY — Demo User Seeder
 *
 * CLI:  ATTENDLY_SEED_PASSWORD='choose-a-password' php scripts/seed-demo-users.php
 *
 * Inserts the demo accounts used for local development. The password is
 * supplied through the required ATTENDLY_SEED_PASSWORD environment variable;
 * it is never stored in source. Passwords are stored ONLY as bcrypt hashes via
 * password_hash() — plaintext never reaches the database. Idempotent: existing
 * emails are skipped, so re-running is safe.
 *
 * Depends on config/config.php (copy from config.example.php).
 */

declare(strict_types=1);

use Attendly\ProgramCatalog;
use Attendly\PublicIdGenerator;

require __DIR__ . '/../config/db.php';
require __DIR__ . '/../src/ProgramCatalog.php';
require __DIR__ . '/../src/PublicIdGenerator.php';

$demoPassword = getenv('ATTENDLY_SEED_PASSWORD');
if (!is_string($demoPassword) || $demoPassword === '') {
    fwrite(STDERR, "ERROR: ATTENDLY_SEED_PASSWORD is required.\n"
        . "Set it to the password the demo accounts should use.\n");
    exit(1);
}

function out(string $msg): void
{
    fwrite(STDOUT, $msg . PHP_EOL);
}

/** Split "First Last" into [first, last]. Extra words fold into last. */
function split_name(string $full): array
{
    $parts = preg_split('/\s+/', trim($full));
    $first = array_shift($parts);
    return [$first, implode(' ', $parts) ?: ''];
}

/**
 * @return int the users.id of the inserted (or existing) user
 */
function upsert_user(PDO $pdo, array $u): int
{
    // Existing email → leave untouched (idempotent).
    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = :email');
    $stmt->execute(['email' => $u['email']]);
    $existing = $stmt->fetchColumn();
    if ($existing !== false) {
        out(sprintf('  – %-22s already exists (id %d)', $u['email'], (int) $existing));
        return (int) $existing;
    }

    $emailName = strstr($u['email'], '@', true) ?: $u['email'];
    $displayName = $u['name'] ?? ucwords(str_replace(['.', '_', '-'], ' ', $emailName));
    $pdo->prepare('INSERT INTO users (public_id, role, email, display_name, password_hash, status)
                   VALUES (:public_id, :role, :email, :display_name, :hash, :status)')
        ->execute([
            'public_id'    => PublicIdGenerator::nextForUser($pdo, $u['role']),
            'role'         => $u['role'],
            'email'        => $u['email'],
            'display_name' => $displayName,
            'hash'         => password_hash($u['password'], PASSWORD_DEFAULT),
            'status'       => $u['status'] ?? 'active',
        ]);

    $id = (int) $pdo->lastInsertId();
    out(sprintf('  + %-22s inserted (id %d, bcrypt hash)', $u['email'], $id));
    return $id;
}

try {
    $pdo = get_db();
} catch (Throwable $e) {
    fwrite(STDERR, "ERROR: could not connect.\n" . $e->getMessage() . "\n"
        . "Run scripts/init-db.sql and check config/config.php first.\n");
    exit(1);
}

out('Seeding demo users (bcrypt-hashed passwords)…');

// ── Administrators ──
$adminIds = [];
$adminIds[] = upsert_user($pdo, [
    'role' => 'administrator', 'email' => 'admin@example.com',         'password' => $demoPassword,
]);
$adminIds[] = upsert_user($pdo, [
    'role' => 'administrator', 'email' => 'santos.admin@example.com',  'password' => $demoPassword,
]);
foreach ($adminIds as $adminId) {
    $pdo->prepare('INSERT IGNORE INTO administrators (user_id) VALUES (:uid)')
        ->execute(['uid' => $adminId]);
}

// ── SSC Officers ──
$officers = [
    ['email' => 'officer@example.com',       'password' => $demoPassword, 'position' => 'Chairperson',      'status' => 'approved'],
    ['email' => 'reyes.officer@example.com', 'password' => $demoPassword, 'position' => 'Vice Chairperson', 'status' => 'approved'],
];
foreach ($officers as $o) {
    $uid = upsert_user($pdo, [
        'role' => 'ssc_officer', 'email' => $o['email'],
        'password' => $o['password'], 'status' => 'active',
    ]);
    $pdo->prepare('INSERT IGNORE INTO ssc_officers (user_id, position, approved_by, approved_at, status)
                   VALUES (:uid, :pos, :by, NOW(), :status)')
        ->execute(['uid' => $uid, 'pos' => $o['position'], 'by' => $adminIds[0], 'status' => $o['status']]);
}

// ── Students (optional sample data for backend development) ──
$students = [
    ['email' => 'student@example.com',  'name' => 'John Student',  'program' => 'BSIT',     'year' => '3', 'block' => 'A', 'idnum' => '2023-00001'],
    ['email' => 'jose@example.com',     'name' => 'Jose Reyes',    'program' => 'BSTM',     'year' => '3', 'block' => 'A', 'idnum' => '2023-00005'],
    ['email' => 'ana@example.com',      'name' => 'Ana Dela Cruz', 'program' => 'BSIT',     'year' => '1', 'block' => 'C', 'idnum' => '2026-00006'],
    ['email' => 'patrick@example.com',  'name' => 'Patrick Lim',   'program' => 'BSN',      'year' => '4', 'block' => 'B', 'idnum' => '2022-00007'],
];
foreach ($students as $s) {
    [$firstName, $lastName] = split_name($s['name']);
    $uid = upsert_user($pdo, [
        'role' => 'student', 'email' => $s['email'], 'name' => $s['name'],
        'password' => $demoPassword,
    ]);
    $department = ProgramCatalog::departmentForProgram($s['program']) ?? 'Unassigned';
    $pdo->prepare('INSERT IGNORE INTO students
                   (user_id, student_id_number, first_name, last_name, department,
                    program, year_level, block)
                   VALUES (:uid, :idnum, :fn, :ln, :department, :program, :year, :block)')
        ->execute([
            'uid' => $uid, 'idnum' => $s['idnum'], 'fn' => $firstName, 'ln' => $lastName,
            'department' => $department,
            'program' => $s['program'], 'year' => $s['year'], 'block' => $s['block'],
        ]);
}

out('Done. Demo accounts use the password from ATTENDLY_SEED_PASSWORD (stored as bcrypt hashes).');

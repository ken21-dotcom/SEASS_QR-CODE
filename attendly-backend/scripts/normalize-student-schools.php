<?php
/**
 * ATTENDLY — Normalize student school assignments
 *
 * CLI: php scripts/normalize-student-schools.php [--remove-demo]
 *
 * Derives every student's school from their program and rewrites legacy
 * full program names ("BSIT – Bachelor ...") to canonical codes (BSIT).
 * The optional --remove-demo flag deletes the named seed accounts that
 * should no longer appear in the dashboard.
 *
 * Idempotent: re-running changes nothing once records are canonical.
 */

declare(strict_types=1);

use Attendly\ProgramCatalog;

require __DIR__ . '/../config/db.php';
require __DIR__ . '/../src/ProgramCatalog.php';

$removeDemo = in_array('--remove-demo', $argv, true);
$demoEmails = [
    'alice@example.com',
    'bob@example.com',
    'maria@example.com',
    'mac@example.com',
];

$pdo = get_db();
$pdo->beginTransaction();

try {
    $rows = $pdo->query(
        "SELECT s.user_id, s.department, s.program
         FROM students s
         JOIN users u ON u.id = s.user_id
         WHERE u.role = 'student'
         ORDER BY s.user_id"
    )->fetchAll();

    $update = $pdo->prepare(
        'UPDATE students SET department = :department, program = :program WHERE user_id = :id'
    );

    $changed = 0;
    foreach ($rows as $row) {
        $program = ProgramCatalog::normalizeProgram($row['program'])
            ?? trim((string) $row['program']);
        $department = ProgramCatalog::departmentForProgram($program)
            ?? ProgramCatalog::normalizeDepartment($row['department'])
            ?? 'Unassigned';

        if ($department !== $row['department'] || $program !== $row['program']) {
            $update->execute([
                'department' => $department,
                'program' => $program,
                'id' => (int) $row['user_id'],
            ]);
            $changed++;
            printf(
                "  updated student %-4d %-12s -> %s\n",
                (int) $row['user_id'],
                (string) $row['program'],
                $department
            );
        }
    }

    $deleted = 0;
    if ($removeDemo) {
        $delete = $pdo->prepare("DELETE FROM users WHERE role = 'student' AND email = :email");
        foreach ($demoEmails as $email) {
            $delete->execute(['email' => $email]);
            $deleted += $delete->rowCount();
            if ($delete->rowCount() > 0) {
                echo "  removed demo student {$email}\n";
            }
        }
    }

    $pdo->commit();
    echo "Done. {$changed} student school assignment(s) normalized";
    if ($removeDemo) {
        echo ", {$deleted} demo account(s) removed";
    }
    echo ".\n";
} catch (Throwable $error) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    fwrite(STDERR, "ERROR: " . $error->getMessage() . "\n");
    exit(1);
}

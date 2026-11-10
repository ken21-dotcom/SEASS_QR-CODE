<?php
/**
 * Remove automated example.test accounts and their dependent data.
 * CLI: php scripts/cleanup-test-accounts.php
 */
declare(strict_types=1);

require __DIR__ . '/../config/db.php';

function out(string $message): void
{
    fwrite(STDOUT, $message . PHP_EOL);
}

try {
    $pdo = get_db();
    $allowedEmails = [
        'admin@example.com',
        'ssc@example.com',
        'student@example.com',
    ];

    $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
    $pdo->beginTransaction();

    $stmt = $pdo->query("SELECT id, email FROM users WHERE email LIKE '%@example.test'");
    $testUsers = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $testIds = array_map(static fn(array $user): int => (int) $user['id'], $testUsers);

    if ($testIds !== []) {
        $placeholders = implode(',', array_fill(0, count($testIds), '?'));

        // Delete records that reference test users before deleting their users.
        $userReferenceColumns = [
            'user_id', 'student_id', 'created_by', 'approved_by', 'ssc_officer_id',
            'administrator_id', 'officer_id', 'recorded_by',
        ];

        $tables = $pdo->query("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'")->fetchAll(PDO::FETCH_COLUMN);
        foreach ($tables as $table) {
            if (!is_string($table) || $table === 'users') {
                continue;
            }

            $columns = $pdo->query('SHOW COLUMNS FROM `' . str_replace('`', '', $table) . '`')->fetchAll(PDO::FETCH_ASSOC);
            foreach ($columns as $column) {
                $columnName = (string) ($column['Field'] ?? '');
                if (in_array($columnName, $userReferenceColumns, true)) {
                    $delete = $pdo->prepare('DELETE FROM `' . str_replace('`', '', $table) . '` WHERE `' . $columnName . '` IN (' . $placeholders . ')');
                    $delete->execute($testIds);
                    break;
                }
            }
        }

        // Remove test users; cascade-capable child tables are handled by FK cascades where present.
        $deleteUsers = $pdo->prepare('DELETE FROM users WHERE id IN (' . $placeholders . ')');
        $deleteUsers->execute($testIds);
    }

    // The defense environment must contain exactly the three approved accounts.
    $allowedPlaceholders = implode(',', array_fill(0, count($allowedEmails), '?'));
    $removeIds = $pdo->prepare("SELECT id FROM users WHERE email NOT IN ($allowedPlaceholders)");
    $removeIds->execute($allowedEmails);
    $otherIds = array_map('intval', $removeIds->fetchAll(PDO::FETCH_COLUMN));
    if ($otherIds !== []) {
        $otherPlaceholders = implode(',', array_fill(0, count($otherIds), '?'));
        $tables = $pdo->query("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'")->fetchAll(PDO::FETCH_COLUMN);
        foreach ($tables as $table) {
            if (!is_string($table) || $table === 'users') {
                continue;
            }
            $columns = $pdo->query('SHOW COLUMNS FROM `' . str_replace('`', '', $table) . '`')->fetchAll(PDO::FETCH_ASSOC);
            foreach ($columns as $column) {
                $columnName = (string) ($column['Field'] ?? '');
                if (in_array($columnName, ['user_id', 'student_id', 'created_by', 'approved_by', 'ssc_officer_id', 'administrator_id', 'officer_id', 'recorded_by'], true)) {
                    $pdo->prepare('DELETE FROM `' . str_replace('`', '', $table) . '` WHERE `' . $columnName . '` IN (' . $otherPlaceholders . ')')
                        ->execute($otherIds);
                }
            }
        }
    }
    $pdo->prepare("DELETE FROM users WHERE email NOT IN ($allowedPlaceholders)")->execute($allowedEmails);

    // Remove child records orphaned by an earlier partial cleanup.
    $pdo->exec('DELETE FROM students WHERE user_id NOT IN (SELECT id FROM users)');
    $pdo->exec('DELETE FROM ssc_officers WHERE user_id NOT IN (SELECT id FROM users)');
    $pdo->exec('DELETE FROM administrators WHERE user_id NOT IN (SELECT id FROM users)');

    $pdo->commit();

    // Clear queued jobs from MySQL when the queue table exists.
    $hasMysqlQueue = (bool) $pdo->query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'job_queue'")->fetchColumn();
    if ($hasMysqlQueue) {
        $pdo->exec('DELETE FROM job_queue');
    }

    $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');

    // Clear the SQLite queue used by the PHP worker.
    $sqlitePath = __DIR__ . '/../queue.sqlite';
    if (is_file($sqlitePath)) {
        $sqlite = new PDO('sqlite:' . $sqlitePath);
        $sqlite->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $sqlite->exec('DROP TABLE IF EXISTS job_queue');
    }

    out('Removed automated users ending in @example.test: ' . count($testUsers));
    out('Remaining users:');

    $remaining = $pdo->query('SELECT id, email, role FROM users ORDER BY role, email')->fetchAll(PDO::FETCH_ASSOC);
    foreach ($remaining as $user) {
        out(sprintf('  id=%d  email=%s  role=%s', $user['id'], $user['email'], $user['role']));
    }

    $unexpected = array_values(array_filter($remaining, static fn(array $user): bool => !in_array((string) $user['email'], $allowedEmails, true)));
    if ($unexpected !== []) {
        throw new RuntimeException('Unexpected users remain after cleanup.');
    }

    if (count($remaining) !== 3) {
        throw new RuntimeException('Expected exactly 3 users, found ' . count($remaining) . '.');
    }

    out('Cleanup complete: exactly the three defense accounts remain.');
} catch (Throwable $e) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    if (isset($pdo) && $pdo instanceof PDO) {
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
    }
    fwrite(STDERR, 'Cleanup failed: ' . $e->getMessage() . PHP_EOL);
    exit(1);
}

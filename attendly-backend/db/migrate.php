<?php
/**
 * ATTENDLY — Custom Migration Runner
 *
 * CLI:  php db/migrate.php [--status]
 *
 * Applies numbered .sql files in db/migrations/ in order, recording each in
 * schema_migrations. MySQL commits DDL implicitly, so a migration that fails
 * halfway must be repaired by hand; the runner stops at the first error
 * instead of skipping ahead. Migration 000 creates the schema_migrations
 * table itself (bootstrapping the runner).
 *
 * No third-party migration tool — same philosophy as the Node plan.
 */

declare(strict_types=1);

require __DIR__ . '/../config/db.php';

function out(string $msg): void
{
    fwrite(STDOUT, $msg . PHP_EOL);
}

try {
    $pdo = get_db(true);
    out('PDO connected.');
} catch (Throwable $e) {
    fwrite(STDERR, "ERROR: could not connect to database.\n"
        . $e->getMessage() . "\n"
        . "Check config/config.php and that you have run scripts/init-db.sql\n");
    exit(1);
}

// Bootstrap: ensure schema_migrations exists (000 also defines it, but the
// runner must be able to write to it even if 000 runs later).
$pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    filename   VARCHAR(255) NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
$index = $pdo->prepare(
    'SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = :table AND index_name = :index LIMIT 1'
);
$index->execute(['table' => 'schema_migrations', 'index' => 'idx_schema_migrations_filename']);
if ($index->fetchColumn() === false) {
    $pdo->exec('CREATE UNIQUE INDEX idx_schema_migrations_filename ON schema_migrations (filename)');
}

$applied = $pdo->query('SELECT filename FROM schema_migrations')
    ->fetchAll(PDO::FETCH_COLUMN);
$appliedSet = array_flip($applied);

$migDir = __DIR__ . '/migrations';
$files  = glob($migDir . '/0*.sql') ?: [];
sort($files);

$pending = array_filter($files, fn(string $f) => !isset($appliedSet[basename($f)]));

$showStatus = in_array('--status', $argv, true);
if ($showStatus) {
    out('Applied migrations:');
    foreach ($applied as $f) {
        out('  ✔ ' . $f);
    }
    out('Pending migrations:');
    if (count($pending) === 0) {
        out('  (none)');
    }
    foreach ($pending as $f) {
        out('  → ' . basename($f));
    }
    exit(0);
}

if (count($pending) === 0) {
    out('No pending migrations. Database is up to date.');
    exit(0);
}

out(sprintf('Applying %d migration(s)…', count($pending)));

$insert = $pdo->prepare('INSERT INTO schema_migrations (filename) VALUES (:filename)');

foreach (array_values($pending) as $i => $sqlFile) {
    $filename = basename($sqlFile);
    out(sprintf('  [%d/%d] %s', $i + 1, count($pending), $filename));

    $sql = file_get_contents($sqlFile);
    if ($sql === false) {
        fwrite(STDERR, "ERROR: could not read $sqlFile\n");
        exit(1);
    }

    try {
        $pdo->exec($sql);
        $insert->execute(['filename' => $filename]);
        out('        ✔ applied');
    } catch (Throwable $e) {
        fwrite(STDERR, "ERROR applying $filename:\n  " . $e->getMessage() . "\n");
        exit(1);
    }
}

out('Done.');

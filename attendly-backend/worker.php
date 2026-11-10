<?php
/**
 * ATTENDLY — Queue Worker
 *
 * Long-running process that drains the async job queue. The queue is
 * stored in a separate SQLite database (attendly-backend/queue.sqlite)
 * so the system demonstrates two data stores: MySQL for core business
 * data and SQLite for the asynchronous job queue.
 *
 * Usage:  php worker.php            (runs until killed)
 */

declare(strict_types=1);

require_once __DIR__ . '/config/db.php';
require_once __DIR__ . '/config/config.php';
require_once __DIR__ . '/src/Repository.php';

use Attendly\Repository;

function out(string $msg): void
{
    fwrite(STDOUT, $msg . PHP_EOL);
}

function getQueueDb(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $path = __DIR__ . '/queue.sqlite';
    $pdo = new PDO('sqlite:' . $path);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

    // Create the queue table on the fly if it does not exist.
    $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS job_queue (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            job_type    TEXT    NOT NULL,
            payload     TEXT    NOT NULL,
            status      TEXT    NOT NULL DEFAULT 'pending',
            attempts    INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        )
    SQL);

    return $pdo;
}

function dequeueJob(PDO $db): ?array
{
    $db->beginTransaction();
    $stmt = $db->prepare(
        "SELECT id, job_type, payload FROM job_queue
         WHERE status = 'pending'
         ORDER BY created_at ASC, id ASC
         LIMIT 1"
    );
    $stmt->execute();
    $job = $stmt->fetch();

    if ($job === false) {
        $db->commit();
        return null;
    }

    $update = $db->prepare(
        "UPDATE job_queue SET status = 'processing', attempts = attempts + 1 WHERE id = :id"
    );
    $update->execute(['id' => $job['id']]);
    $db->commit();

    return $job;
}

function completeJob(PDO $db, int $id, string $status): void
{
    $stmt = $db->prepare("UPDATE job_queue SET status = :status WHERE id = :id");
    $stmt->execute(['status' => $status, 'id' => $id]);
}

function processJob(array $job): bool
{
    $jobType = $job['job_type'];
    $payload = json_decode($job['payload'], true);

    if (!is_array($payload)) {
        fwrite(STDERR, "[worker] ERROR: malformed payload for job {$job['id']}\n");
        return false;
    }

    if ($jobType === 'attendance_correction_request') {
        $correctionId = $payload['correction_request_id'] ?? null;
        $studentId    = $payload['student_id'] ?? null;

        if ($correctionId === null || $studentId === null) {
            fwrite(STDERR, "[worker] ERROR: incomplete payload for job {$job['id']}\n");
            return false;
        }

        out("Processed job {$job['id']} (attendance_correction_request)");
        return true;
    }

    out("Job {$job['id']}: unknown job type '{$jobType}'");
    return false;
}

try {
    $db = getQueueDb();
} catch (Throwable $e) {
    fwrite(STDERR, "ERROR: could not open queue database.\n" . $e->getMessage() . "\n");
    exit(1);
}

out('Worker started. Polling SQLite queue for pending jobs...');

while (true) {
    $job = null;
    try {
        $job = dequeueJob($db);
        if ($job === null) {
            sleep(2);
            continue;
        }

        $ok = processJob($job);
        completeJob($db, (int) $job['id'], $ok ? 'completed' : 'failed');
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        // A job that throws must not stay "processing" forever: nothing would
        // ever pick it up again. Mark it failed so its outcome is final.
        if (is_array($job)) {
            try {
                completeJob($db, (int) $job['id'], 'failed');
            } catch (Throwable) {
                // Leave the row for the next iteration rather than crash here.
            }
        }
        out("Error: " . $e->getMessage());
        sleep(2);
    }
}
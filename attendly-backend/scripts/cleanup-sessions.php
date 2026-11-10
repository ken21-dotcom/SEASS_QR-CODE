<?php
/**
 * ATTENDLY — Session File Cleanup
 *
 * Scans storage/sessions/ and deletes any session files that have not been
 * modified in more than MAX_AGE_HOURS hours. Run this script from the CLI
 * either manually or via a scheduled task / cron job.
 *
 * Usage (from the repo root or attendly-backend/):
 *   php attendly-backend/scripts/cleanup-sessions.php
 *   php attendly-backend/scripts/cleanup-sessions.php --max-age=48   # custom age in hours
 *   php attendly-backend/scripts/cleanup-sessions.php --dry-run       # preview only
 *
 * Exit codes:
 *   0 — completed successfully (or dry-run)
 *   1 — sessions directory not found / not readable
 */

declare(strict_types=1);

// ── CLI-only guard ────────────────────────────────────────────────────────────
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('This script must be run from the command line.' . PHP_EOL);
}

// ── Parse CLI options ─────────────────────────────────────────────────────────
$opts    = getopt('', ['max-age::', 'dry-run']);
$dryRun  = array_key_exists('dry-run', $opts);
$maxAge  = isset($opts['max-age']) ? (int) $opts['max-age'] : 24;

if ($maxAge < 1) {
    fwrite(STDERR, "Error: --max-age must be a positive integer (hours).\n");
    exit(1);
}

// ── Resolve the sessions directory ───────────────────────────────────────────
$sessionsDir = dirname(__DIR__) . '/storage/sessions';

if (!is_dir($sessionsDir)) {
    fwrite(STDERR, "Error: Sessions directory not found: {$sessionsDir}\n");
    exit(1);
}
if (!is_readable($sessionsDir)) {
    fwrite(STDERR, "Error: Sessions directory is not readable: {$sessionsDir}\n");
    exit(1);
}

// ── Run cleanup ───────────────────────────────────────────────────────────────
$cutoff   = time() - ($maxAge * 3600);
$deleted  = 0;
$skipped  = 0;
$errors   = 0;
$label    = $dryRun ? '[DRY-RUN] ' : '';

echo "{$label}ATTENDLY Session Cleanup\n";
echo str_repeat('-', 50) . "\n";
echo "Sessions directory : {$sessionsDir}\n";
echo "Max age            : {$maxAge} hour(s)\n";
echo "Cutoff             : " . date('Y-m-d H:i:s', $cutoff) . "\n";
echo str_repeat('-', 50) . "\n";

/** @var \SplFileInfo $entry */
foreach (new DirectoryIterator($sessionsDir) as $entry) {
    // Only touch regular files whose names start with 'sess_' (PHP default prefix).
    if (!$entry->isFile() || !str_starts_with($entry->getFilename(), 'sess_')) {
        continue;
    }

    $mtime = $entry->getMTime();

    // Keep sessions modified within the allowed window.
    if ($mtime >= $cutoff) {
        $skipped++;
        continue;
    }

    $filePath = $entry->getRealPath();
    $age      = round((time() - $mtime) / 3600, 1);

    if ($dryRun) {
        echo "{$label}Would delete: {$entry->getFilename()} (age: {$age}h)\n";
        $deleted++;
        continue;
    }

    if (unlink($filePath)) {
        echo "Deleted: {$entry->getFilename()} (age: {$age}h)\n";
        $deleted++;
    } else {
        fwrite(STDERR, "Failed to delete: {$filePath}\n");
        $errors++;
    }
}

// ── Summary ───────────────────────────────────────────────────────────────────
echo str_repeat('-', 50) . "\n";
$action = $dryRun ? 'Would delete' : 'Deleted';
echo "{$label}{$action}  : {$deleted} file(s)\n";
echo "{$label}Kept      : {$skipped} file(s)\n";
if ($errors > 0) {
    echo "Errors    : {$errors} file(s) — check stderr output above\n";
}
echo "{$label}Done.\n";
exit($errors > 0 ? 1 : 0);

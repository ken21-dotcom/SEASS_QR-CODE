<?php
/**
 * ATTENDLY — PDO Database Connection
 *
 * Returns a configured PDO instance. Uses a singleton pattern
 * so the connection is shared across the request.
 */

declare(strict_types=1);

// ── PHP timezone ───────────────────────────────────────────────────────────
// Pin PHP's default timezone to the configured campus timezone. Every
// timestamp built without an explicit zone (OTP expiry, late detection,
// report labels) then matches the MySQL session timezone set in get_db(), so
// the two clocks cannot drift apart by hours.
(function (): void {
    $file = __DIR__ . '/config.php';
    if (!is_file($file)) {
        // get_db() reports a missing config with the proper JSON envelope.
        return;
    }

    $cfg = require $file;
    $timezone = (string) ($cfg['tunables']['timezone'] ?? 'Asia/Manila');
    if (!in_array($timezone, timezone_identifiers_list(), true)) {
        $timezone = 'Asia/Manila';
    }
    date_default_timezone_set($timezone);
})();

function get_db(bool $forMigrations = false): PDO
{
    static $pdo = null;

    if ($pdo !== null) {
        return $pdo;
    }

    $cfgFile = __DIR__ . '/config.php';
    if (!is_file($cfgFile)) {
        http_response_code(500);
        echo json_encode([
            'error' => [
                'code'    => 'config_missing',
                'message' => 'config/config.php is missing. Copy config.example.php to config.php and set your values.',
            ],
        ]);
        exit;
    }

    $cfg = require $cfgFile;
    $db = $cfg['db'];
    if ($forMigrations) {
        if (!isset($cfg['migration_db']) || !is_array($cfg['migration_db'])) {
            throw new RuntimeException('config/config.php must define migration_db for schema migrations.');
        }
        $db = array_replace($db, $cfg['migration_db']);
    }

    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=%s',
        $db['host'],
        $db['port'],
        $db['dbname'],
        $db['charset']
    );

    $pdo = new PDO($dsn, $db['user'], $db['password'], [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,  // real prepared statements
    ]);

    // Keep TIMESTAMP reads/writes aligned with the application's configured
    // campus timezone (event DATE/TIME values are stored in that timezone).
    $timezone = new DateTimeZone((string) ($cfg['tunables']['timezone'] ?? 'UTC'));
    $offset = (new DateTimeImmutable('now', $timezone))->format('P');
    $pdo->exec('SET time_zone = ' . $pdo->quote($offset));

    return $pdo;
}

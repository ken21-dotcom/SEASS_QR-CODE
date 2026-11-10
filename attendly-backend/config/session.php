<?php
/**
 * ATTENDLY — Session Configuration
 *
 * Uses PHP's native session handling with secure cookie settings.
 * Session data is stored in a private application directory under storage/.
 * Session ID is regenerated on login to prevent fixation.
 */

declare(strict_types=1);

function init_session(): void
{
    // Only start a session if one isn't already active
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    $cfg     = require __DIR__ . '/config.php';
    $sess    = $cfg['session'];
    $is_prod = ($cfg['app']['env'] === 'production');

    // Keep the server-side session alive for the same period as the cookie.
    $ttlSeconds = (int) $sess['ttl_hours'] * 3600;

    // Detect HTTPS (direct connection or TLS-terminating reverse proxy)
    $is_https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower((string)$_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https')
        || (!empty($_SERVER['SERVER_PORT']) && (int)$_SERVER['SERVER_PORT'] === 443);
    $secure_cookie = $is_prod || $is_https || !empty($sess['cookie_secure']);
    $samesite = $sess['cookie_samesite'] ?? ($secure_cookie ? 'Strict' : 'Lax');

    // Cookie parameters
    session_set_cookie_params([
        'lifetime' => $ttlSeconds,
        'path'     => '/',
        'domain'   => '',            // empty = current domain
        'secure'   => $secure_cookie,
        'httponly' => (bool) ($sess['cookie_httponly'] ?? true),
        'samesite' => $samesite,
    ]);

    // Use a custom cookie name
    session_name($sess['cookie_name']);

    // Session handling settings
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_trans_sid', '0');

    // Garbage collection: run on every request (100/100 = 100 % probability)
    // so that expired session files in storage/sessions/ are removed without
    // relying on a cron job. The GC sweep is fast because the directory only
    // ever holds our own sess_* files.
    ini_set('session.gc_maxlifetime', (string) $ttlSeconds);
    ini_set('session.gc_probability', '1');
    ini_set('session.gc_divisor',     '100');

    // Store sessions in a private application directory instead of the
    // system default, which may be shared or cleaned up by another app.
    $savePath = dirname(__DIR__) . '/storage/sessions';
    if (!is_dir($savePath) && !@mkdir($savePath, 0700, true) && !is_dir($savePath)) {
        throw new RuntimeException('Unable to create session save path: ' . $savePath);
    }
    if (!is_writable($savePath)) {
        throw new RuntimeException('Session save path is not writable: ' . $savePath);
    }
    ini_set('session.save_path', $savePath);

    session_start();
}

/**
 * Regenerate the session ID (call on login to prevent session fixation).
 */
function regenerate_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_regenerate_id(true);
    }
}

/**
 * Destroy the session completely (call on logout).
 */
function destroy_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', [
            'expires' => time() - 42000,
            'path' => $params['path'] ?: '/',
            'domain' => $params['domain'],
            'secure' => $params['secure'],
            'httponly' => $params['httponly'],
            'samesite' => $params['samesite'] ?? 'Lax',
        ]);
        $_SESSION = [];
        session_destroy();
    }
}

<?php
/**
 * ATTENDLY — Front Controller
 *
 * Single entry point for the JSON API. Routed by method + path so the
 * API can live behind one URL instead of a directory of PHP files.
 *
 * Every response is JSON. Errors use a stable envelope:
 *   { "error": { "code": "...", "message": "..." } }
 *
 */

declare(strict_types=1);

require __DIR__ . '/../config/db.php';
require __DIR__ . '/../config/session.php';
require __DIR__ . '/../src/Response.php';
require __DIR__ . '/../src/Auth.php';
require __DIR__ . '/../src/Validator.php';
require __DIR__ . '/../src/RateLimiter.php';
require __DIR__ . '/../src/Repository.php';
require __DIR__ . '/../src/routes.php';

use Attendly\Response;
use Attendly\Auth;
use Attendly\Repository;
use Attendly\RateLimiter;
use Attendly\ValidationException;

/**
 * Whether a browser Origin may call the API.
 *
 * Configured origins always pass. In development, a localhost origin or any
 * RFC1918 LAN address is also accepted, so a phone can reach the API after
 * DHCP hands the laptop a new address without editing config.php each time.
 */
function attendly_origin_allowed(string $origin, array $allowedOrigins, bool $devMode): bool
{
    if ($origin === '') {
        return true;
    }
    foreach ($allowedOrigins as $allowedOrigin) {
        if (is_string($allowedOrigin) && hash_equals($allowedOrigin, $origin)) {
            return true;
        }
    }
    if (!$devMode) {
        return false;
    }

    $parts = parse_url($origin);
    if (!is_array($parts)) {
        return false;
    }
    $scheme = strtolower((string) ($parts['scheme'] ?? ''));
    if ($scheme !== 'http' && $scheme !== 'https') {
        return false;
    }
    $host = strtolower((string) ($parts['host'] ?? ''));
    if ($host === 'localhost' || $host === '127.0.0.1' || $host === '::1') {
        return true;
    }
    if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false) {
        return false;
    }
    return str_starts_with($host, '10.')
        || str_starts_with($host, '192.168.')
        || preg_match('/^172\.(1[6-9]|2\d|3[01])\./', $host) === 1;
}

// ── CORS (config-driven; credentials require an allowed origin) ──
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Permissions-Policy: camera=(self), microphone=()');
// These responses carry PII, QR tokens and face photos; never let a browser
// or proxy keep a copy on disk.
header('Cache-Control: no-store');

$configFile = __DIR__ . '/../config/config.php';
if (!is_file($configFile)) {
    Response::fail('config_missing', 'config/config.php is missing.', 500);
}
$config = require $configFile;
$allowedOrigins = (array) ($config['cors']['allowed_origins'] ?? []);
$devCors = ($config['cors']['dev_allow_cors'] ?? false) === true;

// Reject an oversized body from its declared length before json_decode()
// copies it. 4 MB leaves room for a 2 MB proof image plus the JSON envelope.
if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 4 * 1024 * 1024) {
    Response::fail('payload_too_large', 'Request body is too large.', 413);
}

// Session-cookie mutations require an explicit API header. Browser forms
// cannot set it, which blocks CSRF from other origins, including sibling ports.
if (in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'XMLHttpRequest') {
        Response::fail('csrf_rejected', 'Request verification failed.', 403);
    }
    $requestOrigin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($requestOrigin !== '' && !attendly_origin_allowed($requestOrigin, $allowedOrigins, $devCors)) {
        Response::fail('csrf_rejected', 'Request origin is not allowed.', 403);
    }
}

if (($config['cors']['dev_allow_cors'] ?? false) === true) {
    $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($origin !== '' && attendly_origin_allowed($origin, $allowedOrigins, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Access-Control-Allow-Credentials: true');
        header('Vary: Origin');
    }
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, X-Requested-With');
        header('Access-Control-Max-Age: 86400');
        http_response_code(204);
        exit;
    }
}

// ── Route table ───────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path   = rtrim(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/', '/');
if ($path === '') {
    $path = '/';
}

// Strip the mount prefix so the app works from a subdirectory or via
// the PHP built-in server at /index.php.
$prefix = (string) ($config['app']['api_prefix'] ?? '/api');
// Require a path boundary: "/apifoo" must not be read as prefix "/api".
if ($prefix !== '' && $prefix !== '/' && ($path === $prefix || str_starts_with($path, $prefix . '/'))) {
    $path = substr($path, strlen($prefix));
}
$path = '/' . ltrim($path, '/');

try {
    $db    = get_db();
    $repo  = new Repository($db);
    $auth  = new Auth($db);
    $limiter = new RateLimiter($db);
    $ctx   = ['repo' => $repo, 'auth' => $auth, 'limiter' => $limiter, 'method' => $method, 'config' => $config];

    respond(attendly_route($path, $method, $ctx));
} catch (ValidationException $e) {
    Response::fail($e->errorCode, $e->getMessage(), $e->status);
} catch (Throwable $e) {
    // Never leak a stack trace or SQL fragment to the client.
    error_log('[attendly] ' . $e->getMessage());
    Response::fail('server_error', 'An unexpected error occurred.', 500);
}

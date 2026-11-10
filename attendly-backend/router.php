<?php
/**
 * ATTENDLY — Router for PHP's built-in development server
 *
 * The built-in server only serves files that exist on disk and 404s
 * everything else, so /api/health would never reach the front
 * controller. This script sends real files to the server and hands
 * every other request to public/index.php.
 *
 * Development only. In production point the web server's rewrite rules
 * at public/index.php instead, e.g. for Apache:
 *
 *   RewriteEngine On
 *   RewriteCond %{REQUEST_FILENAME} !-f
 *   RewriteRule ^ public/index.php [QSA,L]
 *
 * Usage:
 *   php -S localhost:8000 -t public router.php
 */

declare(strict_types=1);

$uri  = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = __DIR__ . '/public' . $uri;

// Serve existing static files (and the front controller itself) directly.
if ($uri !== '/' && is_file($path)) {
    return false;
}

require __DIR__ . '/public/index.php';

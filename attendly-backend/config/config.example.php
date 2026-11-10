<?php
/**
 * ATTENDLY — Configuration
 * Copy this file to config.php and fill in your values.
 * config.php is gitignored and never committed.
 */

return [

    // ─── Database ───────────────────────────────────────────────
    'db' => [
        'host'    => '127.0.0.1',
        'port'    => 3306,
        'dbname'  => 'attendly_seass_db',
        'user'    => 'attendly_app',
        'password'=> 'attendly_pass',
        'charset' => 'utf8mb4',
    ],

    // Used only by `php db/migrate.php`, never by web requests.
    'migration_db' => [
        'user' => 'attendly_migrator',
        'password' => 'attendly_migrate_pass',
    ],

    // ─── Session ────────────────────────────────────────────────
    'session' => [
        'cookie_name'  => 'attendly_sid',
        'cookie_httponly' => true,
        'cookie_secure'  => false,   // true in production (HTTPS)
        'cookie_samesite' => 'Lax',
        'ttl_hours'    => 8,
    ],

    // ─── CORS ───────────────────────────────────────────────────
    // Allowed origin for cross-origin requests (set to the frontend URL).
    // The documented dev setup serves the frontend on :5173 and the API on
    // :8000, so this must be true locally. Turn it off when the frontend and
    // API share an origin in production.
    // Add your phone's current LAN IP here when testing on mobile.
    'cors' => [
        'allowed_origins' => [
            'http://localhost:5173',
            'http://192.168.254.110:5173',
            'http://192.168.100.64:5173',
        ],
        'dev_allow_cors' => true,
    ],

    // ─── App ────────────────────────────────────────────────────
    'app' => [
        'env' => 'development',   // 'development' or 'production'
        // URL prefix the API is mounted under. The front controller strips
        // this from REQUEST_URI before routing, and js/api.js must be
        // pointed at <backend>/<prefix> (e.g. http://localhost:8000/api).
        'api_prefix' => '/api',
    ],

    // ─── Tunables ───────────────────────────────────────────────
    // Shared defaults for attendance check-in and check-out windows.
    'tunables' => [
        'timezone' => 'Asia/Manila',
        'late_grace_minutes' => 15,
        'checkin_open_minutes_before' => 30,
        'checkin_close_minutes_after' => 360,
        // Fallbacks used when an event has no per-event check-out offsets.
        'checkout_open_minutes_before_end' => 60,
        'checkout_close_minutes_after_end' => 60,
    ],

    // ─── Integration Tokens ───────────────────────────────────────
    // Keep this secret in config.php. config.php is gitignored and never
    // committed. It authenticates requests to the attendance SOAP service.
    'soap_api_token' => 'change-this-to-a-long-random-token',

    // Dedicated HMAC key for event-scoped student QR codes. Must be at least
    // 32 characters; generate one with: php -r "echo bin2hex(random_bytes(32));"
    // Changing this key invalidates every QR code currently displayed.
    'qr_hmac_secret' => 'change-this-to-a-long-random-qr-secret',

    // ─── Email (SMTP) ──────────────────────────────────────────────
    // Never commit real credentials. config.php is gitignored; this file
    // ships placeholder values only. Gmail SMTP via SSL on port 465.
    // Requires an App Password (not your regular Gmail password) when 2-FA
    // is enabled.
    'smtp_host' => 'smtp.gmail.com',
    'smtp_port' => 465,
    'smtp_user' => 'your-gmail@gmail.com',
    'smtp_pass' => 'your-app-password',
    'email_from' => 'ATTENDLY <your-gmail@gmail.com>',
];

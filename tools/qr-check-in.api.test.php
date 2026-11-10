<?php

declare(strict_types=1);

/**
 * End-to-end tests for the server-verified kiosk QR check-in,
 * plus the user token-exposure and sanction-review route contracts.
 *
 * Proves the whole path against a real PHP server and MySQL:
 * a student requests an event-scoped token -> an officer scans it at that
 * event -> attendance row; duplicate/window/inactive/wrong-event guards.
 * Anonymous and student sessions must never be able to record a QR check-in.
 * Staff listings and profile updates must never carry QR tokens, and the
 * sanction review route accepts only integer ids.
 *
 * Run: php tools/qr-check-in.api.test.php
 */

require __DIR__ . '/../attendly-backend/config/db.php';
require __DIR__ . '/../attendly-backend/src/PublicIdGenerator.php';
require __DIR__ . '/../attendly-backend/src/QrToken.php';

error_reporting(E_ALL);
set_error_handler(static function (int $severity, string $message, string $file, int $line): void {
    throw new ErrorException($message, 0, $severity, $file, $line);
});

use Attendly\PublicIdGenerator;
use Attendly\QrToken;

$root = dirname(__DIR__);
$backend = $root . '/attendly-backend';
$config = require $backend . '/config/config.php';
$qrSecret = (string) ($config['qr_hmac_secret'] ?? '');
if (strlen($qrSecret) < 32) {
    fwrite(STDERR, "config/config.php is missing a 32+ character qr_hmac_secret.\n");
    exit(1);
}

$db = get_db();

// The login and registration limiters are per-IP. Clear only this suite's
// loopback buckets so running the tests repeatedly inside one rate-limit
// window does not fail with 429s unrelated to the code under test.
foreach (['login-ip', 'registration-ip'] as $limitedScope) {
    $clearBucket = $db->prepare('DELETE FROM api_rate_limits WHERE bucket_hash = :bucket');
    $clearBucket->execute(['bucket' => hash('sha256', $limitedScope . "\0" . '127.0.0.1')]);
}

$baseUrl = '';
$server = null;
$serverLog = tempnam(sys_get_temp_dir(), 'attendly-qr-checkin-log-');
$userIds = [];
$eventIds = [];
$cookieJars = [];
$correctionRequestIds = [];
$correctionProof = '';
$passed = 0;
$failed = 0;

function test(string $name, callable $fn): void
{
    global $passed, $failed;

    try {
        $fn();
        $passed++;
        fwrite(STDOUT, "  ok    {$name}\n");
    } catch (Throwable $e) {
        $failed++;
        fwrite(STDOUT, "  FAIL  {$name} -> {$e->getMessage()}\n");
    }
}

function same(mixed $expected, mixed $actual): void
{
    if ($expected !== $actual) {
        throw new RuntimeException(
            'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true)
        );
    }
}

function assert_true(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function http_client(string $method, string $path, ?array $body = null, ?string $cookieJar = null): array
{
    global $baseUrl;

    $ch = curl_init($baseUrl . $path);
    $options = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER         => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'X-Requested-With: XMLHttpRequest',
        ],
    ];

    if ($cookieJar !== null) {
        $options[CURLOPT_COOKIEJAR] = $cookieJar;
        $options[CURLOPT_COOKIEFILE] = $cookieJar;
    }
    if ($body !== null) {
        $options[CURLOPT_POSTFIELDS] = json_encode($body, JSON_THROW_ON_ERROR);
    }

    curl_setopt_array($ch, $options);
    $raw = curl_exec($ch);
    if ($raw === false) {
        $error = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('HTTP request failed: ' . $error);
    }

    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);

    $bodyText = substr($raw, $headerSize);
    $decoded = json_decode($bodyText, true);

    return [
        'status' => $status,
        'body'   => is_array($decoded) ? $decoded : null,
        'raw'    => $bodyText,
    ];
}

function free_port(): int
{
    $socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
    if ($socket === false) {
        throw new RuntimeException('Unable to reserve a local port: ' . $errstr);
    }
    $name = stream_socket_get_name($socket, false);
    fclose($socket);

    return (int) substr((string) strrchr((string) $name, ':'), 1);
}

function create_officer(PDO $db, string $suffix, string $password): int
{
    $email = 'officer.' . $suffix . '@example.test';
    $stmt = $db->prepare(
        'INSERT INTO users
            (public_id, role, email, display_name, password_hash, status, must_change_password)
         VALUES
            (:public_id, \'ssc_officer\', :email, \'Test Officer\', :hash, \'active\', 0)'
    );
    $stmt->execute([
        'public_id' => PublicIdGenerator::nextForUser($db, 'ssc_officer'),
        'email' => $email,
        'hash'  => password_hash($password, PASSWORD_DEFAULT),
    ]);
    $userId = (int) $db->lastInsertId();

    $officer = $db->prepare(
        'INSERT INTO ssc_officers (user_id, position, approved_by, approved_at, status)
         VALUES (:uid, \'Test Officer\', NULL, NOW(), \'approved\')'
    );
    $officer->execute(['uid' => $userId]);

    return $userId;
}

function create_admin(PDO $db, string $suffix, string $password): int
{
    $email = 'admin.' . $suffix . '@example.test';
    $stmt = $db->prepare(
        'INSERT INTO users
            (public_id, role, email, display_name, password_hash, status, must_change_password)
         VALUES
            (:public_id, \'administrator\', :email, \'Test Admin\', :hash, \'active\', 0)'
    );
    $stmt->execute([
        'public_id' => PublicIdGenerator::nextForUser($db, 'administrator'),
        'email' => $email,
        'hash'  => password_hash($password, PASSWORD_DEFAULT),
    ]);
    $userId = (int) $db->lastInsertId();

    $admin = $db->prepare('INSERT INTO administrators (user_id) VALUES (:uid)');
    $admin->execute(['uid' => $userId]);

    return $userId;
}

function create_event(PDO $db, int $createdBy, string $name, DateTimeImmutable $start, string $status = 'scheduled'): int
{
    // Ensure the attendance_type column exists (migration 038).
    $columns = $db->query("SHOW COLUMNS FROM events LIKE 'attendance_type'")->fetchAll();
    if (!$columns) {
        $db->exec("ALTER TABLE events ADD COLUMN attendance_type ENUM('single','in_out','four_point') NOT NULL DEFAULT 'single' AFTER target_department");
    }
    // Ensure scan_number exists on attendance_records (migration 038).
    $scanCols = $db->query("SHOW COLUMNS FROM attendance_records LIKE 'scan_number'")->fetchAll();
    if (!$scanCols) {
        $db->exec("ALTER TABLE attendance_records ADD COLUMN scan_number TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER check_out_time");
    }

    $stmt = $db->prepare(
        'INSERT INTO events
            (public_id, name, description, event_date, start_time, end_time, venue, event_type, status, created_by, attendance_type)
         VALUES
            (:public_id, :name, :description, :event_date, :start_time, :end_time, :venue, \'mandatory\', :status, :created_by, \'single\')'
    );
    $stmt->execute([
        'public_id'   => PublicIdGenerator::nextForEvent($db),
        'name'        => $name,
        'description' => 'Integration test event',
        'event_date'  => $start->format('Y-m-d'),
        'start_time'  => $start->format('H:i:s'),
        'end_time'    => $start->modify('+1 hour')->format('H:i:s'),
        'venue'       => 'Test Venue',
        'status'      => $status,
        'created_by'  => $createdBy,
    ]);

    return (int) $db->lastInsertId();
}

function login(string $email, string $password, array &$cookieJars): array
{
    $jar = tempnam(sys_get_temp_dir(), 'attendly-cookie-');
    if ($jar === false) {
        throw new RuntimeException('Unable to create a cookie jar.');
    }
    $cookieJars[] = $jar;

    $response = http_client('POST', '/auth/login', [
        'email'    => $email,
        'password' => $password,
    ], $jar);

    same(200, $response['status']);
    if (!isset($response['body']['data']['id'])) {
        throw new RuntimeException('Login response did not include a user.');
    }

    return [
        'id'   => (int) $response['body']['data']['id'],
        'user' => $response['body']['data'],
        'jar'  => $jar,
    ];
}

function response_data(array $response): array
{
    if (!isset($response['body']['data']) || !is_array($response['body']['data'])) {
        throw new RuntimeException('Response did not include a data payload: ' . $response['raw']);
    }

    return $response['body']['data'];
}

function response_error(array $response, string $code): void
{
    same($code, $response['body']['error']['code'] ?? null);
}

function attendance_row(PDO $db, int $eventId, int $studentId): array|false
{
    $stmt = $db->prepare(
        'SELECT id, event_id, student_id, check_in_time, check_out_time, verification_method
         FROM attendance_records
         WHERE event_id = :event_id AND student_id = :student_id'
    );
    $stmt->execute(['event_id' => $eventId, 'student_id' => $studentId]);

    return $stmt->fetch();
}

function attendance_count(PDO $db, int $eventId, int $studentId): int
{
    $stmt = $db->prepare(
        'SELECT COUNT(*) FROM attendance_records
         WHERE event_id = :event_id AND student_id = :student_id'
    );
    $stmt->execute(['event_id' => $eventId, 'student_id' => $studentId]);

    return (int) $stmt->fetchColumn();
}

function qr_token_for(int $studentId, int $eventId): string
{
    global $qrSecret;
    return QrToken::generateEventToken($studentId, $eventId, $qrSecret);
}

$suffix = bin2hex(random_bytes(4));
$password = 'TestPass123!';
$timezone = new DateTimeZone((string) ($config['tunables']['timezone'] ?? 'Asia/Manila'));

try {
    // ── Unit-level checks on event-scoped QrToken before HTTP wiring ──
    test('generated event token has the HMAC token format', function (): void {
        $token = qr_token_for(123, 456);
        same('v1.123.456.', substr($token, 0, 11));
        assert_true(QrToken::isValid($token), 'fresh event token rejected by isValid');
        assert_true(strlen(explode('.', $token)[3]) === QrToken::SIGNATURE_LENGTH, 'signature length is wrong');
    });

    test('tokens are scoped to different students and events', function (): void {
        $a = qr_token_for(123, 456);
        $b = qr_token_for(124, 456);
        $c = qr_token_for(123, 457);
        assert_true($a !== $b, 'student scope is not represented in the token');
        assert_true($a !== $c, 'event scope is not represented in the token');
    });

    test('parseEventToken verifies the embedded student and event ids', function () use ($qrSecret): void {
        $token = qr_token_for(123, 456);
        $parsed = QrToken::parseEventToken($token, $qrSecret);
        same(['studentId' => 123, 'eventId' => 456], $parsed);
        $tampered = substr($token, 0, -1) . (substr($token, -1) === 'A' ? 'B' : 'A');
        assert_true(QrToken::parseEventToken($tampered, $qrSecret) === null, 'tampered signature was accepted');
    });

    test('malformed and legacy static tokens are rejected', function (): void {
        foreach([
            '', str_repeat('A', 43), 'v1.123.456.short',
            'v1.0.456.' . str_repeat('A', 43), 'v1.123.456.' . str_repeat('+', 43),
        ] as $bad) {
            assert_true(!QrToken::isValid($bad), "accepted malformed token: {$bad}");
        }
    });

    // ── Seed accounts through the real registration endpoint so the
    //    token comes from registerStudent(), not hand-written SQL. ──
    $adminId = create_admin($db, $suffix, $password);
    $userIds[] = $adminId;
    $officerId = create_officer($db, $suffix, $password);
    $userIds[] = $officerId;

    $now = new DateTimeImmutable('now', $timezone);
    $openEventId = create_event($db, $officerId, 'QR Check-in Open ' . $suffix, $now->modify('-5 minutes'));
    $eventIds[] = $openEventId;

    // Separate in_out event for check-out tests (single-scan events reject check-outs).
    $inOutEventId = create_event($db, $officerId, 'QR Check-in In/Out ' . $suffix, $now->modify('-5 minutes'));
    $db->prepare('UPDATE events SET attendance_type = \'in_out\' WHERE id = :id')->execute(['id' => $inOutEventId]);
    $eventIds[] = $inOutEventId;
    $wrongEventId = create_event($db, $officerId, 'QR Check-in Wrong Event ' . $suffix, $now->modify('-3 minutes'));
    $eventIds[] = $wrongEventId;
    $closedEventId = create_event($db, $officerId, 'QR Check-in Closed ' . $suffix, $now->modify('-7 hours'));
    $eventIds[] = $closedEventId;
    $cancelledEventId = create_event($db, $officerId, 'QR Check-in Cancelled ' . $suffix, $now->modify('-5 minutes'), 'cancelled');
    $eventIds[] = $cancelledEventId;
    $correctionEventId = create_event($db, $officerId, 'Correction Proof ' . $suffix, $now->modify('-1 day'));
    $eventIds[] = $correctionEventId;

    $port = free_port();
    $baseUrl = 'http://127.0.0.1:' . $port . '/api';

    $descriptors = [
        0 => ['pipe', 'r'],
        1 => ['file', $serverLog, 'a'],
        2 => ['file', $serverLog, 'a'],
    ];
    // The PHP built-in server resolves the router script relative to its
    // working directory, so the path must work from the backend folder.
    $routerScript = is_file($backend . '/public/router.php')
        ? 'public/router.php'
        : 'router.php';
    $server = proc_open(
        [PHP_BINARY, '-S', '127.0.0.1:' . $port, '-t', 'public', $routerScript],
        $descriptors,
        $pipes,
        $backend
    );

    if (!is_resource($server)) {
        throw new RuntimeException('Unable to start the PHP development server.');
    }
    fclose($pipes[0]);

    $ready = false;
    for ($attempt = 0; $attempt < 50; $attempt++) {
        usleep(100000);
        try {
            if (http_client('GET', '/health')['status'] === 200) {
                $ready = true;
                break;
            }
        } catch (Throwable) {
        }
    }
    if (!$ready) {
        throw new RuntimeException('API server did not become ready: ' . file_get_contents($serverLog));
    }

    fwrite(STDOUT, "qr-check-in.api.test.php\n");

    // Register two students through POST /auth/register. Accounts land in
    // 'pending'; the admin approves them so they can sign in.
    $regA = http_client('POST', '/auth/register', [
        'firstName' => 'Alpha', 'lastName' => 'Student',
        'studentIdNumber' => '2026-' . str_pad((string) mt_rand(10000, 99999), 5, '0', STR_PAD_LEFT),
        'email' => 'alpha.' . $suffix . '@example.test',
        'password' => $password,
        'department' => 'Computer Studies', 'program' => 'BSIT',
        'yearLevel' => '1', 'block' => 'A',
    ]);
    same(200, $regA['status']);
    $studentAId = (int) response_data($regA)['id'];
    $userIds[] = $studentAId;

    $regB = http_client('POST', '/auth/register', [
        'firstName' => 'Beta', 'lastName' => 'Student',
        'studentIdNumber' => '2026-' . str_pad((string) mt_rand(10000, 99999), 5, '0', STR_PAD_LEFT),
        'email' => 'beta.' . $suffix . '@example.test',
        'password' => $password,
        'department' => 'Computer Studies', 'program' => 'BSCS',
        'yearLevel' => '2', 'block' => 'B',
    ]);
    same(200, $regB['status']);
    $studentBId = (int) response_data($regB)['id'];
    $userIds[] = $studentBId;

    test('registration does not create a permanent qr token', function () use ($db, $studentAId, $studentBId): void {
        $columns = $db->query("SHOW COLUMNS FROM users LIKE 'qr_token'")->fetchAll();
        same([], $columns);
        assert_true((int) $studentAId > 0 && (int) $studentBId > 0, 'student accounts were not created');
    });

    test('registration issues a sequential STUD public id', function () use ($db, $regA, $regB, $studentAId, $studentBId): void {
        $publicA = (string) (response_data($regA)['publicId'] ?? '');
        $publicB = (string) (response_data($regB)['publicId'] ?? '');
        assert_true(preg_match('/^STUD_\d{3,}$/', $publicA) === 1, "bad publicId: {$publicA}");
        assert_true(preg_match('/^STUD_\d{3,}$/', $publicB) === 1, "bad publicId: {$publicB}");
        assert_true($publicA !== $publicB, 'two students share a public id');
        $stored = $db->prepare('SELECT public_id FROM users WHERE id = :id');
        $stored->execute(['id' => $studentAId]);
        same($publicA, (string) $stored->fetchColumn());
    });

    $admin = login('admin.' . $suffix . '@example.test', $password, $cookieJars);
    $approveA = http_client('PATCH', "/users/{$studentAId}/status", ['status' => 'active'], $admin['jar']);
    same(200, $approveA['status']);
    $approveB = http_client('PATCH', "/users/{$studentBId}/status", ['status' => 'active'], $admin['jar']);
    same(200, $approveB['status']);

    $officer = login('officer.' . $suffix . '@example.test', $password, $cookieJars);
    $studentA = login('alpha.' . $suffix . '@example.test', $password, $cookieJars);
    $studentB = login('beta.' . $suffix . '@example.test', $password, $cookieJars);

    test('events expose EVNT public ids', function () use ($db, $officer, $openEventId): void {
        $stored = $db->prepare('SELECT public_id FROM events WHERE id = :id');
        $stored->execute(['id' => $openEventId]);
        $publicId = (string) $stored->fetchColumn();
        assert_true(preg_match('/^EVNT_\d{3,}$/', $publicId) === 1, "bad event publicId: {$publicId}");

        $list = http_client('GET', '/events', null, $officer['jar']);
        same(200, $list['status']);
        $match = null;
        foreach (response_data($list) as $row) {
            if ((int) ($row['id'] ?? 0) === $openEventId) { $match = $row; break; }
        }
        assert_true(is_array($match), 'event missing from /events');
        same($publicId, (string) ($match['publicId'] ?? ''));
    });

    test('student can request an event-scoped QR token', function () use ($studentA, $studentAId, $openEventId, $qrSecret): void {
        $response = http_client('GET', '/events/' . $openEventId . '/qr-token', null, $studentA['jar']);
        same(200, $response['status']);
        $data = response_data($response);
        same($openEventId, (int) $data['eventId']);
        $token = (string) ($data['qrToken'] ?? '');
        same(['studentId' => $studentAId, 'eventId' => $openEventId], QrToken::parseEventToken($token, $qrSecret));
    });

    test('non-student cannot request an event QR token', function () use ($officer, $openEventId): void {
        $response = http_client('GET', '/events/' . $openEventId . '/qr-token', null, $officer['jar']);
        same(403, $response['status']);
        response_error($response, 'forbidden');
    });

    test('ended event QR token request is rejected', function () use ($studentA, $closedEventId): void {
        $response = http_client('GET', '/events/' . $closedEventId . '/qr-token', null, $studentA['jar']);
        same(409, $response['status']);
        response_error($response, 'event_ended');
    });

    test('login response does not expose a permanent qrToken', function () use ($studentA): void {
        assert_true(!array_key_exists('qrToken', $studentA['user']), 'login payload exposed qrToken');
    });

    test('login and /auth/me expose the student public id', function () use ($studentA): void {
        $publicId = (string) ($studentA['user']['publicId'] ?? '');
        assert_true(preg_match('/^STUD_\d{3,}$/', $publicId) === 1, "login publicId: {$publicId}");

        $me = http_client('GET', '/auth/me', null, $studentA['jar']);
        same(200, $me['status']);
        same($publicId, (string) (response_data($me)['publicId'] ?? ''));
    });

    test('/auth/me does not expose a permanent qrToken', function () use ($studentA): void {
        $me = http_client('GET', '/auth/me', null, $studentA['jar']);
        same(200, $me['status']);
        assert_true(!array_key_exists('qrToken', response_data($me)), '/auth/me exposed qrToken');
    });

    test('student profile save treats contactNumber as optional', function () use ($studentA, $suffix): void {
        $email = 'alpha.' . $suffix . '@example.test';

        $blank = http_client('PATCH', '/users/me/profile', [
            'email' => $email,
            'contactNumber' => '',
        ], $studentA['jar']);
        same(200, $blank['status']);
        $blankData = response_data($blank);
        same($email, (string) ($blankData['email'] ?? ''));
        assert_true(
            ($blankData['contactNumber'] ?? null) === null,
            'a blank contact number should clear the stored value'
        );

        $null = http_client('PATCH', '/users/me/profile', [
            'email' => $email,
            'contactNumber' => null,
        ], $studentA['jar']);
        same(200, $null['status']);

        $valid = http_client('PATCH', '/users/me/profile', [
            'email' => $email,
            'contactNumber' => '+63 917 123 4567',
        ], $studentA['jar']);
        same(200, $valid['status']);
        same('+63 917 123 4567', (string) (response_data($valid)['contactNumber'] ?? ''));

        $tooLong = http_client('PATCH', '/users/me/profile', [
            'email' => $email,
            'contactNumber' => str_repeat('9', 21),
        ], $studentA['jar']);
        same(422, $tooLong['status']);
    });

    test('student profile save rejects an email or phone owned by another user', function () use ($db, $studentA, $studentB, $suffix): void {
        $emailA = 'alpha.' . $suffix . '@example.test';
        $emailB = 'beta.' . $suffix . '@example.test';
        $phoneB = '+63 918 555 0101';

        // Give Beta a contact number so the phone conflict check has real data.
        $setB = http_client('PATCH', '/users/me/profile', [
            'email' => $emailB,
            'contactNumber' => $phoneB,
        ], $studentB['jar']);
        same(200, $setB['status']);

        $duplicateEmail = http_client('PATCH', '/users/me/profile', [
            'email' => $emailB,
            'contactNumber' => '+63 917 123 4567',
        ], $studentA['jar']);
        same(409, $duplicateEmail['status']);
        response_error($duplicateEmail, 'email_taken');
        same('This email is already in use.', (string) ($duplicateEmail['body']['error']['message'] ?? ''));

        $duplicatePhone = http_client('PATCH', '/users/me/profile', [
            'email' => $emailA,
            'contactNumber' => $phoneB,
        ], $studentA['jar']);
        same(409, $duplicatePhone['status']);
        response_error($duplicatePhone, 'phone_taken');
        same('This contact number is already in use.', (string) ($duplicatePhone['body']['error']['message'] ?? ''));

        // A rejected save must leave Alpha's stored row untouched.
        $stored = $db->prepare('SELECT email, contact_number FROM users WHERE id = :id');
        $stored->execute(['id' => $studentA['id']]);
        $row = $stored->fetch();
        same($emailA, (string) ($row['email'] ?? ''));
        same('+63 917 123 4567', (string) ($row['contact_number'] ?? ''));
    });

    test('correction requests require a real proof image', function () use ($studentA, $correctionEventId, $now): void {
        $time = $now->modify('-1 day')->format('Y-m-d H:i');
        $base = [
            'eventId' => $correctionEventId,
            'checkInTime' => $time,
            'reason' => 'The kiosk did not scan my QR code.',
        ];

        $missing = http_client('POST', '/attendance-corrections', $base, $studentA['jar']);
        same(422, $missing['status']);
        response_error($missing, 'invalid_field');

        $notImage = http_client('POST', '/attendance-corrections', $base + [
            'proofImage' => 'data:image/png;base64,' . base64_encode(str_repeat('not-an-image', 40)),
        ], $studentA['jar']);
        same(422, $notImage['status']);
        response_error($notImage, 'invalid_field');

        $svg = http_client('POST', '/attendance-corrections', $base + [
            'proofImage' => 'data:image/svg+xml;base64,' . base64_encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        ], $studentA['jar']);
        same(422, $svg['status']);
        response_error($svg, 'invalid_field');
    });

    test('correction request stores proof and hides the image from list responses', function () use ($db, $studentA, $officer, $correctionEventId, $now, &$correctionRequestIds, &$correctionProof): void {
        $proof = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
        $correctionProof = $proof;
        $created = http_client('POST', '/attendance-corrections', [
            'eventId' => $correctionEventId,
            'checkInTime' => $now->modify('-1 day')->format('Y-m-d H:i'),
            'reason' => 'The kiosk did not scan my QR code.',
            'proofImage' => $proof,
        ], $studentA['jar']);
        same(200, $created['status']);
        $row = response_data($created);
        $requestId = (int) ($row['id'] ?? 0);
        assert_true($requestId > 0, 'correction response did not include an id');
        same(true, (bool) ($row['hasProof'] ?? false));
        assert_true(!array_key_exists('proofImage', $row), 'create response leaked the proof image');
        $correctionRequestIds[] = $requestId;

        $stored = $db->prepare('SELECT proof_image FROM attendance_correction_requests WHERE id = :id');
        $stored->execute(['id' => $requestId]);
        same($proof, (string) $stored->fetchColumn());

        $ownerList = http_client('GET', '/attendance-corrections', null, $studentA['jar']);
        same(200, $ownerList['status']);
        $ownerRow = null;
        foreach (response_data($ownerList) as $candidate) {
            if ((int) ($candidate['id'] ?? 0) === $requestId) { $ownerRow = $candidate; break; }
        }
        assert_true(is_array($ownerRow), 'owner could not see their correction request');
        same(true, (bool) ($ownerRow['hasProof'] ?? false));
        assert_true(!array_key_exists('proofImage', $ownerRow), 'owner list leaked the proof image');

        $staffList = http_client('GET', '/attendance-corrections', null, $officer['jar']);
        same(200, $staffList['status']);
        $staffRow = null;
        foreach (response_data($staffList) as $candidate) {
            if ((int) ($candidate['id'] ?? 0) === $requestId) { $staffRow = $candidate; break; }
        }
        assert_true(is_array($staffRow), 'staff could not see the correction request');
        same(true, (bool) ($staffRow['hasProof'] ?? false));
        assert_true(!array_key_exists('proofImage', $staffRow), 'staff list leaked the proof image');
    });

    test('proof endpoint returns the image to the owner and staff only', function () use ($studentA, $studentB, $officer, &$correctionRequestIds, &$correctionProof): void {
        $requestId = (int) ($correctionRequestIds[0] ?? 0);
        assert_true($requestId > 0, 'no correction request to read');

        $owner = http_client('GET', "/attendance-corrections/{$requestId}/proof", null, $studentA['jar']);
        same(200, $owner['status']);
        same($correctionProof, (string) (response_data($owner)['proofImage'] ?? ''));

        $staff = http_client('GET', "/attendance-corrections/{$requestId}/proof", null, $officer['jar']);
        same(200, $staff['status']);
        same($correctionProof, (string) (response_data($staff)['proofImage'] ?? ''));

        $foreign = http_client('GET', "/attendance-corrections/{$requestId}/proof", null, $studentB['jar']);
        same(404, $foreign['status']);
        response_error($foreign, 'not_found');
    });

    test('oversized proof images are rejected before decoding', function () use ($studentA, $correctionEventId, $now): void {
        $oversized = http_client('POST', '/attendance-corrections', [
            'eventId' => $correctionEventId,
            'checkInTime' => $now->modify('-1 day')->format('Y-m-d H:i'),
            'reason' => 'Oversized proof payload test.',
            'proofImage' => 'data:image/png;base64,' . str_repeat('A', 2800001),
        ], $studentA['jar']);
        same(422, $oversized['status']);
        response_error($oversized, 'invalid_field');
    });

    test('correction requests reject a null or empty proof image', function () use ($studentA, $correctionEventId, $now): void {
        $nullProof = http_client('POST', '/attendance-corrections', [
            'eventId' => $correctionEventId,
            'checkInTime' => $now->modify('-1 day')->format('Y-m-d H:i'),
            'reason' => 'Null proof payload test.',
            'proofImage' => null,
        ], $studentA['jar']);
        same(422, $nullProof['status']);
        response_error($nullProof, 'invalid_field');

        $emptyProof = http_client('POST', '/attendance-corrections', [
            'eventId' => $correctionEventId,
            'checkInTime' => $now->modify('-1 day')->format('Y-m-d H:i'),
            'reason' => 'Empty proof payload test.',
            'proofImage' => '',
        ], $studentA['jar']);
        same(422, $emptyProof['status']);
        response_error($emptyProof, 'invalid_field');
    });

    test('a student cannot view another student proof image', function () use ($studentA, $studentB, $officer, &$correctionRequestIds, &$correctionProof): void {
        $requestId = (int) ($correctionRequestIds[0] ?? 0);
        assert_true($requestId > 0, 'no correction request to read');

        $foreign = http_client('GET', "/attendance-corrections/{$requestId}/proof", null, $studentB['jar']);
        same(404, $foreign['status']);
        response_error($foreign, 'not_found');
    });

    test('a student cannot review a correction request', function () use ($studentA, &$correctionRequestIds): void {
        $requestId = (int) ($correctionRequestIds[0] ?? 0);
        assert_true($requestId > 0, 'no correction request to review');

        $denied = http_client('PATCH', "/attendance-corrections/{$requestId}/review", [
            'decision' => 'denied',
            'notes' => 'Should not be allowed.',
        ], $studentA['jar']);
        same(403, $denied['status']);
        response_error($denied, 'forbidden');
    });

    test('staff listing other students does not leak qr tokens', function () use ($db, $officer): void {
        $list = http_client('GET', '/users', null, $officer['jar']);
        same(200, $list['status']);
        $rows = response_data($list);
        assert_true(is_array($rows) && count($rows) > 0, 'officer saw no users');
        foreach ($rows as $row) {
            if ((int) ($row['id'] ?? 0) === 0) continue;
            $token = $row['qrToken'] ?? null;
            if ($token === null) continue;
            // If a token is present at all, it must belong to the viewer —
            // an officer has none, so any non-null value is a leak.
            throw new RuntimeException('qrToken leaked to an officer listing: user ' . $row['id']);
        }
    });

    test('admin and officer user listings omit the qrToken field', function () use ($admin, $officer): void {
        foreach (['admin' => $admin, 'officer' => $officer] as $role => $session) {
            $list = http_client('GET', '/users', null, $session['jar']);
            same(200, $list['status']);
            $rows = response_data($list);
            assert_true(is_array($rows) && count($rows) > 0, "{$role} saw no users");
            foreach ($rows as $row) {
                assert_true(
                    !array_key_exists('qrToken', $row),
                    "qrToken field leaked to the {$role} listing for user " . ($row['id'] ?? '?')
                );
            }
        }
    });

    test('admin profile update response omits the qrToken field', function () use ($admin, $studentAId, $suffix): void {
        $update = http_client('PATCH', "/users/{$studentAId}/profile", [
            'name'       => 'Alpha Student',
            'email'      => 'alpha.' . $suffix . '@example.test',
            'department' => 'Computer Studies',
            'program'    => 'BSIT',
            'yearLevel'  => '1',
        ], $admin['jar']);
        same(200, $update['status']);
        $updated = response_data($update);
        same($studentAId, (int) ($updated['id'] ?? 0));
        assert_true(
            !array_key_exists('qrToken', $updated),
            'qrToken field leaked in the profile update response'
        );
    });

    test('sanction report endpoint returns the semester matrix', function () use ($admin): void {
        $response = http_client('GET', '/reports/sanctions', null, $admin['jar']);
        same(200, $response['status']);
        $data = response_data($response);
        assert_true(is_array($data['events'] ?? null), 'sanction report events are missing');
        assert_true(is_array($data['students'] ?? null), 'sanction report students are missing');
        $range = $data['range'] ?? [];
        assert_true(array_key_exists('department', $range) && array_key_exists('program', $range),
            'sanction report range is missing the department/program scope');
    });

    $tokenA = qr_token_for($studentAId, $openEventId);
    $tokenB = qr_token_for($studentBId, $openEventId);

    // Tokens scoped to the in_out event for check-out tests.
    $inOutTokenA = qr_token_for($studentAId, $inOutEventId);
    $inOutTokenB = qr_token_for($studentBId, $inOutEventId);

    test('anonymous QR check-in is rejected', function () use ($db, $openEventId, $tokenA, $studentAId): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $openEventId,
            'qrToken' => $tokenA,
        ]);
        same(401, $response['status']);
        response_error($response, 'unauthenticated');
        same(false, attendance_row($db, $openEventId, $studentAId));
    });

    test('student session cannot record a QR check-in', function () use ($db, $studentA, $openEventId, $tokenA, $studentAId): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $openEventId,
            'qrToken' => $tokenA,
        ], $studentA['jar']);
        same(403, $response['status']);
        response_error($response, 'forbidden');
        same(false, attendance_row($db, $openEventId, $studentAId));
    });

    test('missing qrToken is rejected', function () use ($officer, $openEventId): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $openEventId,
        ], $officer['jar']);
        same(422, $response['status']);
        response_error($response, 'invalid_field');
    });

    test('malformed qrToken never reaches the index', function () use ($officer, $openEventId): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $openEventId,
            'qrToken' => 'too-short',
        ], $officer['jar']);
        same(422, $response['status']);
        response_error($response, 'invalid_qr');
    });

    test('well-formed but unknown qrToken returns invalid_qr, not a 404 leak', function () use ($officer, $openEventId): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $openEventId,
            'qrToken' => qr_token_for(2147483646, $openEventId),
        ], $officer['jar']);
        same(422, $response['status']);
        response_error($response, 'invalid_qr');
    });

    test('missing event id is rejected', function () use ($officer, $tokenA): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'qrToken' => $tokenA,
        ], $officer['jar']);
        same(422, $response['status']);
        response_error($response, 'invalid_field');
    });

    test('unknown event returns event_not_found', function () use ($officer, $studentAId): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => 2147483647,
            'qrToken' => qr_token_for($studentAId, 2147483647),
        ], $officer['jar']);
        same(404, $response['status']);
        response_error($response, 'event_not_found');
    });

    test('QR token for a different live event is rejected', function () use ($officer, $openEventId, $wrongEventId, $studentAId, $db): void {
        $wrongToken = qr_token_for($studentAId, $wrongEventId);
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $openEventId,
            'qrToken' => $wrongToken,
        ], $officer['jar']);
        same(400, $response['status']);
        response_error($response, 'invalid_qr_event');
        same('Invalid QR code for this event.', $response['body']['error']['message'] ?? null);
        same(false, attendance_row($db, $openEventId, $studentAId));
    });

    test('cancelled event is refused before recording', function () use ($officer, $cancelledEventId, $studentAId, $db): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $cancelledEventId,
            // Scope the token to this event: a token for another event is now
            // rejected as invalid_qr_event before the status check runs.
            'qrToken' => qr_token_for($studentAId, $cancelledEventId),
        ], $officer['jar']);
        same(409, $response['status']);
        response_error($response, 'event_unavailable');
        same(false, attendance_row($db, $cancelledEventId, $studentAId));
    });

    test('token for another event is rejected before the closed-window check', function () use ($officer, $closedEventId, $tokenA, $studentAId, $db): void {
        // A stale code scanned at a closed kiosk must report the event mismatch,
        // not checkin_closed, which would reveal that the event is open.
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $closedEventId,
            'qrToken' => $tokenA,
        ], $officer['jar']);
        same(400, $response['status']);
        response_error($response, 'invalid_qr_event');
        same('Invalid QR code for this event.', $response['body']['error']['message'] ?? null);
        same(false, attendance_row($db, $closedEventId, $studentAId));
    });

    test('closed check-in window is refused', function () use ($officer, $closedEventId, $studentAId, $db): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $closedEventId,
            'qrToken' => qr_token_for($studentAId, $closedEventId),
        ], $officer['jar']);
        same(409, $response['status']);
        response_error($response, 'checkin_closed');
        same(false, attendance_row($db, $closedEventId, $studentAId));
    });

    $success = null;

    test('officer scan checks in the token owner', function () use ($officer, $openEventId, $tokenA, $studentAId, &$success): void {
        $success = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $openEventId,
            'qrToken' => $tokenA,
        ], $officer['jar']);

        same(200, $success['status']);
        $data = response_data($success);
        same($studentAId, (int) $data['studentId']);
        assert_true(str_contains((string) $data['studentName'], 'Alpha'), 'unexpected studentName: ' . $data['studentName']);
        same('qr', $data['verificationMethod']);
        same('in', $data['action']);
        assert_true((bool) preg_match('/^\d{2}:\d{2}$/', (string) $data['time']), 'time was not HH:MM');
    });

    test('successful scan writes a qr attendance row', function () use ($db, $openEventId, $studentAId): void {
        $row = attendance_row($db, $openEventId, $studentAId);
        if ($row === false) {
            throw new RuntimeException('Attendance row was not created.');
        }
        same($openEventId, (int) $row['event_id']);
        same($studentAId, (int) $row['student_id']);
        same('qr', $row['verification_method']);
        assert_true(strlen((string) $row['check_in_time']) >= 19, 'check_in_time was not a timestamp');
    });

    // Check in to the in_out event so check-out tests have a row to work with.
    test('in_out check-in for check-out tests', function () use ($officer, $inOutEventId, $inOutTokenA, $studentAId): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $inOutEventId,
            'qrToken' => $inOutTokenA,
        ], $officer['jar']);
        same(200, $response['status']);
        same('in', response_data($response)['action']);
    });

    test('duplicate scan returns duplicate_checkin', function () use ($officer, $openEventId, $tokenA): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $openEventId,
            'qrToken' => $tokenA,
        ], $officer['jar']);
        same(409, $response['status']);
        response_error($response, 'duplicate_checkin');
    });

    test('unknown action is rejected', function () use ($officer, $openEventId, $tokenA): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $openEventId,
            'qrToken' => $tokenA,
            'action' => 'sideways',
        ], $officer['jar']);
        same(422, $response['status']);
        response_error($response, 'invalid_field');
    });

    test('check-out before check-in returns not_checked_in', function () use ($officer, $inOutEventId, $inOutTokenB, $studentBId, $db): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $inOutEventId,
            'qrToken' => $inOutTokenB,
            'action' => 'out',
        ], $officer['jar']);
        same(409, $response['status']);
        response_error($response, 'not_checked_in');
        same(false, attendance_row($db, $inOutEventId, $studentBId));
    });

    test('check-out updates the checked-in row instead of duplicating it', function () use ($officer, $inOutEventId, $inOutTokenA, $studentAId, $db): void {
        $before = attendance_row($db, $inOutEventId, $studentAId);
        if ($before === false) {
            throw new RuntimeException('Check-in row disappeared before check-out.');
        }
        same(null, $before['check_out_time']);

        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $inOutEventId,
            'qrToken' => $inOutTokenA,
            'action' => 'out',
        ], $officer['jar']);

        same(200, $response['status']);
        $data = response_data($response);
        same('out', $data['action']);
        same($studentAId, (int) $data['studentId']);
        same('qr', $data['verificationMethod']);
        assert_true((bool) $data['checkedOut'], 'checkedOut flag missing');
        assert_true((bool) preg_match('/^\d{2}:\d{2}$/', (string) $data['checkOutTimeLabel']), 'check-out time was not HH:MM');

        $after = attendance_row($db, $inOutEventId, $studentAId);
        if ($after === false) {
            throw new RuntimeException('Check-out row disappeared.');
        }
        same((int) $before['id'], (int) $after['id']);
        assert_true($after['check_out_time'] !== null && $after['check_out_time'] !== '', 'check_out_time was not written');
        same(1, attendance_count($db, $inOutEventId, $studentAId));
    });

    test('second check-out returns duplicate_checkout', function () use ($officer, $inOutEventId, $inOutTokenA): void {
        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $inOutEventId,
            'qrToken' => $inOutTokenA,
            'action' => 'out',
        ], $officer['jar']);
        same(409, $response['status']);
        response_error($response, 'duplicate_checkout');
    });

    test('inactive student cannot check in even with a valid token', function () use ($db, $admin, $officer, $openEventId, $tokenB, $studentBId): void {
        $deactivate = http_client('PATCH', "/users/{$studentBId}/status", ['status' => 'inactive'], $admin['jar']);
        same(200, $deactivate['status']);

        $response = http_client('POST', '/attendance/qr-check-in', [
            'eventId' => $openEventId,
            'qrToken' => $tokenB,
        ], $officer['jar']);
        same(422, $response['status']);
        response_error($response, 'invalid_qr');
        same(false, attendance_row($db, $openEventId, $studentBId));
    });

    test('the retired qr_token column is absent', function () use ($db): void {
        $columns = $db->query("SHOW COLUMNS FROM users LIKE 'qr_token'")->fetchAll();
        same([], $columns);
    });

    test('manual check-in fallback still works', function () use ($db, $admin, $officer, $openEventId, $studentBId): void {
        $reactivate = http_client('PATCH', '/users/' . $studentBId . '/status', ['status' => 'active'], $admin['jar']);
        same(200, $reactivate['status']);
        $response = http_client('POST', '/attendance/manual', [
            'eventId' => $openEventId,
            'studentId' => $studentBId,
            'action' => 'in',
        ], $officer['jar']);
        same(200, $response['status']);
        $data = response_data($response);
        same($studentBId, (int) $data['studentId']);
        same('manual', $data['verificationMethod']);
        assert_true(attendance_row($db, $openEventId, $studentBId) !== false, 'manual attendance row was not created');
    });
} catch (Throwable $e) {
    $failed++;
    fwrite(STDERR, "FATAL: {$e->getMessage()}\n");
} finally {
    if (is_resource($server)) {
        $status = proc_get_status($server);
        if ($status['running']) {
            proc_terminate($server);
        }
        proc_close($server);
    }

    foreach ($cookieJars as $jar) {
        if (is_file($jar)) {
            unlink($jar);
        }
    }

    if ($correctionRequestIds !== []) {
        $placeholders = implode(',', array_fill(0, count($correctionRequestIds), '?'));
        try {
            $cleanup = $db->prepare('DELETE FROM attendance_correction_requests WHERE id IN (' . $placeholders . ')');
            $cleanup->execute($correctionRequestIds);
        } catch (Throwable $e) {
            fwrite(STDERR, 'cleanup warning: ' . $e->getMessage() . "\n");
        }
    }

    if ($eventIds !== []) {
        $placeholders = implode(',', array_fill(0, count($eventIds), '?'));
        try {
            $cleanup = $db->prepare('DELETE FROM attendance_records WHERE event_id IN (' . $placeholders . ')');
            $cleanup->execute($eventIds);
            $cleanup = $db->prepare('DELETE FROM events WHERE id IN (' . $placeholders . ')');
            $cleanup->execute($eventIds);
        } catch (Throwable $e) {
            fwrite(STDERR, 'cleanup warning: ' . $e->getMessage() . "\n");
        }
    }

    if ($userIds !== []) {
        $placeholders = implode(',', array_fill(0, count($userIds), '?'));
        try {
            $cleanup = $db->prepare('DELETE FROM users WHERE id IN (' . $placeholders . ')');
            $cleanup->execute($userIds);
        } catch (Throwable $e) {
            fwrite(STDERR, 'cleanup warning: ' . $e->getMessage() . "\n");
        }
    }

    if ($failed > 0 && is_file($serverLog)) {
        $lines = file($serverLog, FILE_IGNORE_NEW_LINES);
        if ($lines !== false && $lines !== []) {
            fwrite(STDERR, "server log:\n" . implode("\n", array_slice($lines, -20)) . "\n");
        }
    }
    if (is_file($serverLog)) {
        unlink($serverLog);
    }
}

fwrite(STDOUT, "\n{$passed} API assertions passed.\n");

if ($failed > 0) {
    fwrite(STDERR, "{$failed} API assertion(s) failed.\n");
    exit(1);
}
<?php
/**
 * ATTENDLY — Route Table
 *
 * Maps method + path to a handler. Paths support ":param" segments and
 * are matched in declaration order, so literal paths must come before
 * parameterised ones.
 *
 * $ctx = ['repo' => Repository, 'auth' => Auth, 'method' => string, 'config' => array]
 */

declare(strict_types=1);

use Attendly\Response;

/**
 * Send a matched route's payload to the client and end the request.
 *
 * @param array{0:int,1:callable} $route
 */
function respond(array $route): void
{
    [$status, $handler] = $route;
    Response::ok($handler(), $status);
}

/**
 * @param array<string,mixed> $ctx
 * @return array{0:int,1:callable}
 */
function attendly_route(string $path, string $method, array $ctx): array
{
    $repo  = $ctx['repo'];
    $auth  = $ctx['auth'];
    $match = null;

    /**
     * Server-side QR check-in.
     *
     * Only a signed-in officer or administrator may operate the kiosk, so
     * the route requires a role before it accepts a token. The token is a
     * signed HMAC carrying the student and event ids; the server verifies
     * both the signature and the event scope before writing attendance.
     */
    $qrCheckIn = function () use ($repo, $auth, $ctx): array {
        $officer = $auth->requireRole(['admin', 'ssc-officer']);
        $ctx['limiter']->consume('qr-checkin-user', (string) $officer['id'], 300, 60);

        $body = Response::body();
        $action = strtolower(trim((string) ($body['action'] ?? 'in')));
        if (!in_array($action, ['in', 'out'], true)) {
            Response::fail('invalid_field', 'Field "action" must be "in" or "out".', 422);
        }

        return $repo->checkInByQr(
            Response::requireBodyId($body, 'eventId'),
            Response::requireString($body, 'qrToken'),
            (string) ($ctx['config']['qr_hmac_secret'] ?? ''),
            $action,
            (int) ($ctx['config']['tunables']['checkin_open_minutes_before'] ?? 30),
            (int) ($ctx['config']['tunables']['checkin_close_minutes_after'] ?? 360),
            (string) ($ctx['config']['tunables']['timezone'] ?? 'Asia/Manila'),
            (int) ($ctx['config']['tunables']['late_grace_minutes'] ?? 15),
            (int) ($ctx['config']['tunables']['checkout_open_minutes_before_end'] ?? 60),
            (int) ($ctx['config']['tunables']['checkout_close_minutes_after_end'] ?? 60)
        );
    };

    $routes = [
        // ── Health ──
        ['GET', '/health', function () use ($ctx): array {
            $tunables = $ctx['config']['tunables'] ?? [];
            return [
                'status' => 'ok',
                'checkinOpenMinutesBefore' => (int) ($tunables['checkin_open_minutes_before'] ?? 30),
                'checkinCloseMinutesAfter' => (int) ($tunables['checkin_close_minutes_after'] ?? 360),
                'checkoutOpenMinutesBeforeEnd' => (int) ($tunables['checkout_open_minutes_before_end'] ?? 60),
                'checkoutCloseMinutesAfterEnd' => (int) ($tunables['checkout_close_minutes_after_end'] ?? 60),
            ];
        }],

        // ── Auth ──
        ['POST', '/auth/login', function () use ($auth, $ctx): array {
            $body = Response::body();
            $email = Response::requireString($body, 'email');
            $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
            $ctx['limiter']->consume('login-ip', $ip, 50, 60);
            $ctx['limiter']->consume('login-account', strtolower(trim($email)), 50, 60);
            return $auth->login(
                $email,
                Response::requireString($body, 'password')
            );
        }],
        ['POST', '/auth/register', function () use ($repo, $ctx): array {
            $ctx['limiter']->consume('registration-ip', (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 50, 60);
            $body = Response::body();
            return $repo->registerStudent([
                'firstName'       => Response::requireString($body, 'firstName'),
                'lastName'        => Response::requireString($body, 'lastName'),
                'studentIdNumber' => Response::requireString($body, 'studentIdNumber'),
                'email'           => Response::requireString($body, 'email'),
                'password'        => Response::requireString($body, 'password'),
                'department'      => Response::requireString($body, 'department'),
                'program'         => Response::requireString($body, 'program'),
                'yearLevel'       => Response::requireString($body, 'yearLevel'),
                'block'           => Response::requireString($body, 'block'),
            ]);
        }],
        ['POST', '/auth/verify-otp', function () use ($repo, $ctx): array {
            $ctx['limiter']->consume('verify-otp-ip', (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 20, 900);
            $body = Response::body();
            $email = strtolower(trim(Response::requireString($body, 'email')));
            $ctx['limiter']->consume('verify-otp-account', $email, 10, 900);
            return $repo->verifyOtp(
                $email,
                Response::requireString($body, 'otp')
            );
        }],
        ['POST', '/auth/logout', function () use ($auth): array {
            $auth->logout();
            return ['ok' => true];
        }],
        ['GET', '/auth/me', function () use ($auth): array {
            return $auth->currentUser() ?? ['user' => null];
        }],
        ['POST', '/auth/password', function () use ($auth): array {
            $user = $auth->requireUser();
            $body = Response::body();
            $auth->changePassword(
                $user,
                Response::requireString($body, 'currentPassword'),
                Response::requireString($body, 'newPassword')
            );
            return ['ok' => true];
        }],

        // ── Users ──
        ['GET', '/users', function () use ($repo, $auth): array {
            // Scope sensitive records by role in Repository::listUsers().
            $viewer = $auth->requireRole(['admin', 'ssc-officer', 'student']);
            $status = query_string('status');
            $role   = query_string('role');

            if ($status !== null || $role !== null) {
                if ($viewer['role'] !== 'admin') {
                    Response::fail('forbidden', 'Only administrators can filter user records.', 403);
                }

                $status = $status !== null ? strtolower($status) : null;
                $role   = $role !== null ? strtolower($role) : null;

                if ($status !== null && !in_array($status, ['pending', 'active', 'inactive'], true)) {
                    Response::fail('invalid_field', 'Query parameter "status" is invalid.', 422);
                }
                if ($role !== null && !in_array($role, ['student', 'ssc-officer', 'admin'], true)) {
                    Response::fail('invalid_field', 'Query parameter "role" is invalid.', 422);
                }
            }

            return $repo->listUsers($viewer, $status, $role);
        }],
        ['PATCH', '/users/:id/status', function () use ($repo, $auth, &$match): array {
            $admin = $auth->requireRole(['admin']);
            $body  = Response::body();
            return $repo->updateUserStatus(
                Response::requireId($match, 'id'),
                Response::requireString($body, 'status'),
                $admin
            );
        }],
        // Literal "/users/me/*" routes must precede "/users/:id/*" so the
        // router does not try to parse "me" as a numeric user id.
        ['PATCH', '/users/me/profile', function () use ($repo, $auth): array {
            $viewer = $auth->requireRole(['student']);
            $body = Response::body();
            return $repo->updateOwnProfile((int) $viewer['id'], $body);
        }],
        ['POST', '/users/me/deactivate', function () use ($repo, $auth): array {
            $viewer = $auth->requireRole(['student']);
            $repo->deactivateOwnAccount((int) $viewer['id']);
            return ['ok' => true];
        }],
        ['PATCH', '/users/:id/profile', function () use ($repo, $auth, &$match): array {
            $auth->requireRole(['admin']);
            $body = Response::body();
            return $repo->updateStudentProfile(Response::requireId($match, 'id'), $body);
        }],
        ['POST', '/users/officers', function () use ($repo, $auth): array {
            $admin = $auth->requireRole(['admin']);
            $body  = Response::body();

            return $repo->createOfficer([
                'firstName' => Response::requireString($body, 'firstName'),
                'lastName'  => Response::requireString($body, 'lastName'),
                'email'     => Response::requireString($body, 'email'),
                'password'  => Response::requireString($body, 'password'),
                'position'  => Response::requireString($body, 'position'),
            ], $admin);
        }],
        // ── Events ──
        // The kiosk needs the schedule before anyone signs in, so the list
        // is intentionally readable without a session.
        ['GET', '/announcements', function () use ($repo, $auth): array {
            $user = $auth->requireUser();
            return $repo->listAnnouncements((int) $user['id']);
        }],
        ['GET', '/events', function () use ($repo, $auth): array {
            return $repo->listEvents($auth->currentUser());
        }],
        ['GET', '/events/:id/qr-token', function () use ($repo, $auth, $ctx, &$match): array {
            $student = $auth->requireRole(['student']);
            $ctx['limiter']->consume('event-qr-user', (string) $student['id'], 120, 60);

            return $repo->issueEventQrToken(
                (int) $student['id'],
                Response::requireId($match, 'id'),
                (string) ($ctx['config']['qr_hmac_secret'] ?? ''),
                (string) ($ctx['config']['tunables']['timezone'] ?? 'Asia/Manila')
            );
        }],
        ['POST', '/events', function () use ($repo, $auth, $ctx): array {
            // Administrators and approved SSC officers both operate the
            // Manage Events page, and events.created_by references users(id)
            // (migration 040), so either role may create an event.
            $actor = $auth->requireRole(['ssc-officer', 'admin']);
            $body  = Response::body();
            $tunables = $ctx['config']['tunables'] ?? [];
            return $repo->createEvent([
                'name'        => Response::requireString($body, 'name'),
                'date'        => Response::requireString($body, 'date'),
                'startTime'   => Response::requireString($body, 'startTime'),
                'endTime'     => Response::requireString($body, 'endTime'),
                'venue'       => Response::requireString($body, 'venue'),
                'eventType'   => $body['eventType'] ?? 'mandatory',
                'eventCategory' => $body['eventCategory'] ?? null,
                'semester'    => $body['semester'] ?? 'N/A',
                'targetDepartment' => $body['targetDepartment'] ?? null,
                'attendanceType' => $body['attendanceType'] ?? 'single',
                'description' => $body['description'] ?? null,
                'checkoutOpenMinutes'  => $body['checkoutOpenMinutes']
                    ?? (int) ($tunables['checkout_open_minutes_before_end'] ?? 60),
                'checkoutCloseMinutes' => $body['checkoutCloseMinutes']
                    ?? (int) ($tunables['checkout_close_minutes_after_end'] ?? 60),
            ], $actor);
        }],
        ['PATCH', '/events/:id', function () use ($repo, $auth, &$match): array {
            $actor = $auth->requireRole(['ssc-officer', 'admin']);
            return $repo->updateEvent(Response::requireId($match, 'id'), Response::body(), $actor);
        }],
        ['DELETE', '/events/:id', function () use ($repo, $auth, &$match): array {
            $actor = $auth->requireRole(['ssc-officer', 'admin']);
            $repo->deleteEvent(Response::requireId($match, 'id'), $actor);
            return ['ok' => true];
        }],

// ── Attendance ──
        ['GET', '/attendance', function () use ($repo, $auth, $ctx): array {
            // Students only ever see their own rows; staff see everything
            // or one event.
            $viewer    = $auth->requireRole(['admin', 'ssc-officer', 'student']);
            $isStudent = $viewer['role'] === 'student';
            // A student cannot widen their scope by passing ?event_id.
            $eventId   = $isStudent ? null : query_id('event_id');
            $studentId = $isStudent ? $viewer['id'] : query_id('student_id');
            return $repo->listAttendance(
                $eventId,
                $studentId,
                (int) ($ctx['config']['tunables']['late_grace_minutes'] ?? 15)
            );
        }],
        // Staff report builder. Students are intentionally excluded: the
        // /attendance route above already scopes their own rows.
        ['GET', '/reports/attendance', function () use ($repo, $auth, $ctx): array {
            $auth->requireRole(['admin', 'ssc-officer']);
            $eventId = array_key_exists('eventId', $_GET)
                ? query_id('eventId')
                : query_id('event_id');
            $yearLevel = array_key_exists('yearLevel', $_GET)
                ? query_string('yearLevel')
                : query_string('year_level');
            $semester = query_string('semester');
            return $repo->listAttendanceReport(
                [
                    'eventId' => $eventId,
                    'department' => query_string('department'),
                    'program' => query_string('program'),
                    'yearLevel' => $yearLevel,
                    'semester' => $semester,
                ],
                (int) ($ctx['config']['tunables']['late_grace_minutes'] ?? 15)
            );
        }],
        // Semester/date-range attendance matrix joined with each student's
        // sanction status. Date bounds are optional and inclusive, and an
        // optional eventIds list narrows every event-scoped column to the
        // selected events (an empty list means all events).
        ['GET', '/reports/sanctions', function () use ($repo, $auth): array {
            $auth->requireRole(['admin', 'ssc-officer']);
            $eventIds = query_id_list('eventIds');
            $singleEventId = array_key_exists('eventId', $_GET)
                ? query_id('eventId')
                : query_id('event_id');
            if ($singleEventId !== null) {
                $eventIds[] = $singleEventId;
                $eventIds = array_values(array_unique($eventIds));
            }
            // Each id becomes a bound parameter in two queries; keep one
            // request from turning the matrix into thousands of placeholders.
            if (count($eventIds) > 200) {
                Response::fail('invalid_field', 'Select at most 200 events for one report.', 422);
            }
            $range = [];
            foreach (['from', 'to'] as $key) {
                $value = query_string($key);
                if ($value === null) {
                    $range[$key] = null;
                    continue;
                }
                $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $value);
                if ($date === false || $date->format('Y-m-d') !== $value) {
                    Response::fail(
                        'invalid_field',
                        'Query parameter "' . $key . '" must be a valid YYYY-MM-DD date.',
                        422
                    );
                }
                $range[$key] = $value;
            }
            if ($range['from'] !== null && $range['to'] !== null
                && $range['from'] > $range['to']) {
                Response::fail('invalid_field', 'The "from" date must not be after "to".', 422);
            }
            return $repo->listSanctionMatrix(
                $range['from'],
                $range['to'],
                $eventIds,
                query_string('semester'),
                query_string('department'),
                query_string('program')
            );
        }],
        ['GET', '/attendance-corrections', function () use ($repo, $auth): array {
            $viewer = $auth->requireRole(['admin', 'ssc-officer', 'student']);
            return $repo->listAttendanceCorrectionRequests(
                $viewer['role'] === 'student' ? (int) $viewer['id'] : null
            );
        }],
        ['GET', '/attendance-corrections/:id/proof', function () use ($repo, $auth, &$match): array {
            $viewer = $auth->requireRole(['admin', 'ssc-officer', 'student']);
            $proof = $repo->findAttendanceCorrectionProof(Response::requireId($match, 'id'));
            // A missing row, a legacy row with no image, and another
            // student's row all answer 404 so request ids stay unguessable.
            if ($proof === null
                || $proof['proofImage'] === null
                || ($viewer['role'] === 'student' && $proof['studentId'] !== (int) $viewer['id'])) {
                Response::fail('not_found', 'Proof image not found.', 404);
            }
            return ['proofImage' => $proof['proofImage']];
        }],
        ['POST', '/attendance-corrections', function () use ($repo, $auth, $ctx): array {
            $student = $auth->requireRole(['student']);
            $body = Response::body();
            return $repo->createAttendanceCorrectionRequest(
                (int) $student['id'],
                Response::requireBodyId($body, 'eventId'),
                Response::requireString($body, 'checkInTime'),
                Response::requireString($body, 'reason'),
                Response::requireString($body, 'proofImage'),
                (string) ($ctx['config']['tunables']['timezone'] ?? 'Asia/Manila')
            );
        }],
        ['PATCH', '/attendance-corrections/:id/review', function () use ($repo, $auth, &$match): array {
            $reviewer = $auth->requireRole(['admin', 'ssc-officer']);
            $body = Response::body();
            return $repo->reviewAttendanceCorrectionRequest(
                Response::requireId($match, 'id'),
                Response::requireString($body, 'decision'),
                isset($body['notes']) ? Response::requireString($body, 'notes') : null,
                $reviewer
            );
        }],
        // ── QR check-in (the current kiosk front door) ──
        // The officer-gated QR path verifies the HMAC and event scope before
        // resolving the active student id carried inside the token.
        ['POST', '/attendance/qr-check-in', $qrCheckIn],
        ['POST', '/attendance/manual', function () use ($repo, $auth, $ctx): array {
            $auth->requireRole(['admin', 'ssc-officer']);
            $body = Response::body();
            $action = strtolower(trim((string) ($body['action'] ?? 'in')));
            if (!in_array($action, ['in', 'out'], true)) {
                Response::fail('invalid_field', 'Field "action" must be "in" or "out".', 422);
            }
            $timezone = (string) ($ctx['config']['tunables']['timezone'] ?? 'Asia/Manila');
            $lateGrace = (int) ($ctx['config']['tunables']['late_grace_minutes'] ?? 15);

            $attendance = $action === 'out'
                ? $repo->checkOut([
                    'eventId' => Response::requireBodyId($body, 'eventId'),
                    'studentId' => Response::requireBodyId($body, 'studentId'),
                ],
                    (int) ($ctx['config']['tunables']['checkout_open_minutes_before_end'] ?? 60),
                    (int) ($ctx['config']['tunables']['checkout_close_minutes_after_end'] ?? 60),
                    $timezone,
                    $lateGrace
                )
                : $repo->checkIn([
                    'eventId' => Response::requireBodyId($body, 'eventId'),
                    'studentId' => Response::requireBodyId($body, 'studentId'),
                    'verificationMethod' => 'manual',
                ],
                    (int) ($ctx['config']['tunables']['checkin_open_minutes_before'] ?? 30),
                    (int) ($ctx['config']['tunables']['checkin_close_minutes_after'] ?? 360),
                    $timezone,
                    $lateGrace
                );
            $attendance['action'] = $action;
            return $attendance;
        }],

        ['GET', '/reenrollment-requests', function () use ($repo, $auth): array {
            $viewer = $auth->requireRole(['admin', 'ssc-officer', 'student']);
            return $repo->listReenrollmentRequests(
                $viewer['role'] === 'student' ? $viewer['id'] : query_id('student_id')
            );
        }],
        ['POST', '/reenrollment-requests', function () use ($repo, $auth): array {
            $student = $auth->requireRole(['student']);
            $body = Response::body();
            return $repo->createReenrollmentRequest(
                (int) $student['id'],
                Response::requireString($body, 'reason')
            );
        }],
        ['PATCH', '/reenrollment-requests/:id/review', function () use ($repo, $auth, &$match): array {
            $admin = $auth->requireRole(['admin']);
            $body = Response::body();
            return $repo->reviewReenrollmentRequest(
                Response::requireId($match, 'id'),
                Response::requireString($body, 'decision'),
                $admin
            );
        }],
        ['GET', '/audit-logs', function () use ($repo, $auth): array {
            $auth->requireRole(['admin', 'ssc-officer']);
            $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 50;
            return $repo->listAuditLogs($limit > 0 ? min($limit, 200) : 50);
        }],

        ['GET', '/stations', function () use ($repo, $auth): array {
            $auth->requireRole(['admin']);
            return $repo->listKioskStations();
        }],
        ['POST', '/stations', function () use ($repo, $auth): array {
            $admin = $auth->requireRole(['admin']);
            $body = Response::body();
            return $repo->createKioskStation(
                Response::requireString($body, 'name'),
                optional_body_string($body, 'device', 100),
                optional_body_string($body, 'location', 150),
                $admin
            );
        }],
        ['POST', '/stations/:id/heartbeat', function () use ($repo, $auth, &$match): array {
            $auth->requireRole(['admin', 'ssc-officer']);
            return $repo->heartbeatKioskStation(Response::requireId($match, 'id'));
        }],
        ['DELETE', '/stations/:id', function () use ($repo, $auth, &$match): array {
            $auth->requireRole(['admin']);
            $repo->deleteKioskStation(Response::requireId($match, 'id'));
            return ['ok' => true];
        }],
    ];

    foreach ($routes as [$routeMethod, $pattern, $handler]) {
        if ($routeMethod !== $method) {
            continue;
        }
        $params = match_path($pattern, $path);
        if ($params !== null) {
            $match = $params;
            return [200, $handler];
        }
    }

    // Path matched a verb we do not implement — tell the client honestly.
    $allowed = [];
    foreach ($routes as [$routeMethod, $pattern]) {
        if (match_path($pattern, $path) !== null) {
            $allowed[] = $routeMethod;
        }
    }
    if ($allowed !== []) {
        header('Allow: ' . implode(', ', $allowed));
        Response::fail('method_not_allowed', 'That method is not supported for this route.', 405);
    }

    Response::fail('not_found', 'No API route matches ' . $path . '.', 404);
}

/**
 * Read an optional positive integer from the query string.
 *
 * Returns null when the parameter is absent, and fails the request when
 * it is present but not a positive whole number — casting "abc" to 0
 * would silently turn a typo into a filter that matches nothing.
 */
function query_id(string $key): ?int
{
    if (!array_key_exists($key, $_GET)) {
        return null;
    }
    return Response::requireBodyId($_GET, $key);
}

/**
 * Read an optional list of positive integer ids from the query string.
 *
 * Accepts `?eventIds[]=1&eventIds[]=2` (the form the reports UI sends).
 * A scalar value is tolerated for older callers, and blank entries are
 * ignored so clearing the selector means "no filter".
 *
 * @return int[]
 */
function query_id_list(string $key): array
{
    if (!array_key_exists($key, $_GET)) {
        return [];
    }

    $raw = $_GET[$key];
    if (!is_array($raw)) {
        $raw = [$raw];
    }

    $ids = [];
    foreach ($raw as $value) {
        if ($value === '' || $value === null) {
            continue;
        }
        $id = Response::requireBodyId([$key => $value], $key);
        $ids[$id] = $id;
    }
    return array_values($ids);
}

function optional_body_string(array $body, string $key, int $maxLength): ?string
{
    if (!array_key_exists($key, $body) || $body[$key] === null) {
        return null;
    }

    $value = $body[$key];
    if (!is_string($value) || trim($value) === '') {
        Response::fail('invalid_field', "Field \"$key\" must be a non-empty string.", 422);
    }

    $value = trim($value);
    if (strlen($value) > $maxLength) {
        Response::fail('invalid_field', "Field \"$key\" is too long.", 422);
    }

    return $value;
}

/**
 * Read an optional trimmed string from the query string.
 */
function query_string(string $key): ?string
{
    if (!array_key_exists($key, $_GET)) {
        return null;
    }

    $value = $_GET[$key];
    if (!is_string($value) || trim($value) === '') {
        Response::fail('invalid_field', "Query parameter \"$key\" is invalid.", 422);
    }
    return trim($value);
}

/**
 * Match a "/a/:id" pattern against a concrete path.
 *
 * @return array<string,string>|null captured params, or null when no match
 */
function match_path(string $pattern, string $path): ?array
{
    $patternParts = explode('/', trim($pattern, '/'));
    $pathParts    = explode('/', trim($path, '/'));

    if ($path === '/') {
        $patternParts = [];
        $pathParts    = [];
    }

    if (count($patternParts) !== count($pathParts)) {
        return null;
    }

    $params = [];
    foreach ($patternParts as $i => $part) {
        if (str_starts_with($part, ':')) {
            $params[substr($part, 1)] = $pathParts[$i];
            continue;
        }
        if ($part !== $pathParts[$i]) {
            return null;
        }
    }
    return $params;
}

<?php

require_once __DIR__ . '/../config/db.php';

function soapBearerToken(): string
{
    $authorization = '';
    if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
        $authorization = (string) $_SERVER['HTTP_AUTHORIZATION'];
    } elseif (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $authorization = (string) $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    } elseif (function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strcasecmp((string) $name, 'Authorization') === 0) {
                $authorization = (string) $value;
                break;
            }
        }
    }

    if (preg_match('/^Bearer\s+(.+)$/i', trim($authorization), $matches)) {
        return trim($matches[1]);
    }

    // Tokens must never be placed in query strings: URLs are commonly logged
    // by proxies, browsers, monitoring tools, and referrer headers.
    return '';
}

function requireSoapToken(): void
{
    $config = require __DIR__ . '/../config/config.php';
    $expected = (string) ($config['soap_api_token'] ?? '');
    $provided = soapBearerToken();

    if ($expected === '' || $provided === '' || !hash_equals($expected, $provided)) {
        throw new SoapFault('Client', 'Unauthorized');
    }
}

function getStudentAttendance($studentId)
{
    requireSoapToken();

    try {
        $db = get_db();
        $stmt = $db->prepare(
            'SELECT a.id, a.event_id, a.student_id, a.check_in_time, a.verification_method,
                    e.name AS event_name, e.event_date, e.start_time, e.end_time, e.venue
             FROM attendance_records a
             LEFT JOIN events e ON e.id = a.event_id
             WHERE a.student_id = :student_id
             ORDER BY a.check_in_time DESC'
        );
        $stmt->execute(['student_id' => (int)$studentId]);
        $records = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $result = [];
        foreach ($records as $record) {
            $result[] = [
                'id' => (string)$record['id'],
                'eventId' => (string)$record['event_id'],
                'studentId' => (string)$record['student_id'],
                'checkInTime' => $record['check_in_time'],
                'verificationMethod' => $record['verification_method'],
                'eventName' => $record['event_name'],
                'eventDate' => $record['event_date'],
                'startTime' => $record['start_time'],
                'endTime' => $record['end_time'],
                'venue' => $record['venue'],
            ];
        }

        return $result;
    } catch (Throwable $e) {
        error_log('ATTENDLY SOAP database error: ' . $e->getMessage());
        throw new SoapFault('Server', 'Internal error');
    }
}

$wsdl = __DIR__ . '/attendance.wsdl';
if (!is_file($wsdl)) {
    // SoapServer() would fail with a fatal error and leak the path otherwise.
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'WSDL not available.';
    exit;
}
if (isset($_GET['wsdl'])) {
    header('Content-Type: application/xml; charset=utf-8');
    readfile($wsdl);
    exit;
}

$server = new SoapServer($wsdl);
$server->addFunction('getStudentAttendance');
$server->handle();

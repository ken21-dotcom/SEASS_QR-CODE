<?php
/**
 * Seed a small set of realistic demo events, notices, and attendance.
 *
 * CLI: php scripts/seed-demo-content.php
 * Safe to rerun: events, announcements, and check-ins are matched before insert.
 */

declare(strict_types=1);

use Attendly\PublicIdGenerator;

require __DIR__ . '/../config/db.php';
require __DIR__ . '/../src/PublicIdGenerator.php';

function ensure_demo_event(PDO $db, int $officerId, array $event): int
{
    $find = $db->prepare(
        'SELECT id FROM events WHERE name = :name AND event_date = :date AND venue = :venue LIMIT 1'
    );
    $find->execute(['name' => $event['name'], 'date' => $event['date'], 'venue' => $event['venue']]);
    $id = $find->fetchColumn();
    if ($id !== false) {
        return (int) $id;
    }

    $insert = $db->prepare(
        'INSERT INTO events (public_id, name, description, event_date, start_time, end_time, venue, event_type, status, created_by)
         VALUES (:public_id, :name, :description, :date, :start, :end, :venue, :type, :status, :created_by)'
    );
    $insert->execute([
        'public_id' => PublicIdGenerator::nextForEvent($db),
        'name' => $event['name'],
        'description' => $event['description'],
        'date' => $event['date'],
        'start' => $event['start'],
        'end' => $event['end'],
        'venue' => $event['venue'],
        'type' => $event['type'],
        'status' => $event['status'],
        'created_by' => $officerId,
    ]);
    return (int) $db->lastInsertId();
}

function ensure_event_notices(PDO $db, int $eventId, string $title, string $detail): void
{
    $message = json_encode(['title' => $title, 'detail' => $detail], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    $stmt = $db->prepare(
        "INSERT INTO notifications (user_id, type, message, related_entity_type, related_entity_id)
         SELECT u.id, 'announcement', :message, 'announcement:event', :event_id
         FROM users u
         WHERE u.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.user_id = u.id AND n.type = 'announcement'
               AND n.related_entity_type = 'announcement:event' AND n.related_entity_id = :check_event_id
           )"
    );
    $stmt->execute(['message' => $message, 'event_id' => $eventId, 'check_event_id' => $eventId]);
}

try {
    $db = get_db();
    $db->beginTransaction();

    $officer = $db->prepare(
        "SELECT u.id FROM users u JOIN ssc_officers o ON o.user_id = u.id
         WHERE u.email = 'officer@example.com' AND u.status = 'active' AND o.status = 'approved' LIMIT 1"
    );
    $officer->execute();
    $officerId = $officer->fetchColumn();
    if ($officerId === false) {
        throw new RuntimeException('Active approved demo officer "sscofficer" is required.');
    }

    $events = [
        [
            'name' => 'Welcome Week Check-in',
            'description' => 'Sample completed event used to preview attendance reports.',
            'date' => '2026-10-20', 'start' => '08:00:00', 'end' => '12:00:00',
            'venue' => 'Main Campus', 'type' => 'optional', 'status' => 'completed',
        ],
        [
            'name' => 'Campus Wellness and Sports Day',
            'description' => 'Sample campus wellness activities, friendly games, and student organization booths.',
            'date' => '2026-11-05', 'start' => '08:00:00', 'end' => '15:00:00',
            'venue' => 'Campus Activity Center', 'type' => 'optional', 'status' => 'scheduled',
        ],
        [
            'name' => 'Student Research Forum',
            'description' => 'Sample student research presentations and project exhibits.',
            'date' => '2026-11-12', 'start' => '09:00:00', 'end' => '16:00:00',
            'venue' => 'JHCSC Auditorium', 'type' => 'mandatory', 'status' => 'scheduled',
        ],
    ];

    $eventIds = [];
    foreach ($events as $event) {
        $id = ensure_demo_event($db, (int) $officerId, $event);
        $eventIds[$event['name']] = $id;
        $date = (new DateTimeImmutable($event['date']))->format('M j, Y');
        $start = substr($event['start'], 0, 5);
        ensure_event_notices(
            $db,
            $id,
            $event['name'] . ' has been announced',
            $event['venue'] . ' - ' . $date . ' at ' . $start
        );
    }

    // Seed sample check-ins only for the built-in demo accounts.
    $pastEventId = $eventIds['Welcome Week Check-in'];
    $students = $db->query(
        "SELECT s.user_id FROM students s JOIN users u ON u.id = s.user_id
         WHERE u.email IN ('student@example.com', 'jose@example.com', 'ana@example.com', 'patrick@example.com')
           AND u.status = 'active'"
    )->fetchAll(PDO::FETCH_COLUMN);
    $attendance = $db->prepare(
        'INSERT INTO attendance_records (event_id, student_id, check_in_time, verification_method)
         SELECT :event_id, :student_id, :check_in_time, \'manual\'
         WHERE NOT EXISTS (SELECT 1 FROM attendance_records WHERE event_id = :check_event AND student_id = :check_student)'
    );
    foreach ($students as $index => $studentId) {
        $minute = str_pad((string) (5 + $index * 2), 2, '0', STR_PAD_LEFT);
        $attendance->execute([
            'event_id' => $pastEventId,
            'student_id' => (int) $studentId,
            'check_in_time' => '2026-10-20 08:' . $minute . ':00',
            'check_event' => $pastEventId,
            'check_student' => (int) $studentId,
        ]);
    }

    $generalMessage = json_encode([
        'title' => 'Campus attendance reminder',
        'detail' => 'Bring your student ID and check the event schedule before heading to campus.',
    ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    $general = $db->prepare(
        "INSERT INTO notifications (user_id, type, message, related_entity_type, related_entity_id)
         SELECT u.id, 'announcement', :message, 'announcement:general:demo-v1', 1
         FROM users u
         WHERE u.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM notifications n WHERE n.user_id = u.id
               AND n.type = 'announcement' AND n.related_entity_type = 'announcement:general:demo-v1'
               AND n.related_entity_id = 1
           )"
    );
    $general->execute(['message' => $generalMessage]);

    $db->commit();
    fwrite(STDOUT, sprintf(
        "Demo content ready: %d events, %d demo check-ins, review examples added where demo accounts exist; notices sent to active users.\n",
        count($events), count($students)
    ));
} catch (Throwable $error) {
    if (isset($db) && $db instanceof PDO && $db->inTransaction()) {
        $db->rollBack();
    }
    fwrite(STDERR, 'Could not seed demo content: ' . $error->getMessage() . PHP_EOL);
    exit(1);
}

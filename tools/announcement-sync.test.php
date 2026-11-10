<?php

declare(strict_types=1);

/**
 * Regression tests for the announcement <-> event link.
 *
 * Proves that:
 *   - deleting an event also removes its announcement notifications, and
 *   - listAnnouncements() hides announcement rows whose event no longer
 *     exists (data left behind by older builds).
 *
 * Uses the configured MySQL database and cleans up every row it creates.
 *
 * Run: php tools/announcement-sync.test.php
 */

require __DIR__ . '/../attendly-backend/config/db.php';
require __DIR__ . '/../attendly-backend/src/Response.php';
require __DIR__ . '/../attendly-backend/src/Repository.php';

use Attendly\PublicIdGenerator;
use Attendly\Repository;

$db = get_db();
$passed = 0;
$failed = 0;
$eventIds = [];
$notificationIds = [];

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

function announcement_titles(array $rows): array
{
    return array_map(static fn (array $row): string => (string) ($row['title'] ?? ''), $rows);
}

try {
    $userId = (int) $db->query(
        "SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1"
    )->fetchColumn();
    if ($userId <= 0) {
        throw new RuntimeException('No active user exists to receive a test announcement.');
    }

    $creatorId = (int) $db->query(
        'SELECT user_id FROM ssc_officers ORDER BY user_id LIMIT 1'
    )->fetchColumn();
    if ($creatorId <= 0) {
        throw new RuntimeException('No SSC officer exists to own a test event.');
    }

    $insertEvent = $db->prepare(
        "INSERT INTO events
            (public_id, name, description, event_date, start_time, end_time,
             venue, event_type, event_category, status, created_by)
         VALUES
            (:public_id, :name, 'Announcement sync test event', '2099-01-01',
             '08:00:00', '09:00:00', 'Test Venue', 'mandatory', 'major',
             'scheduled', :created_by)"
    );
    $insertEvent->execute([
        'public_id' => PublicIdGenerator::nextForEvent($db),
        'name' => 'Announcement Sync Test Event',
        'created_by' => $creatorId,
    ]);
    $eventId = (int) $db->lastInsertId();
    $eventIds[] = $eventId;

    $insertNotice = $db->prepare(
        "INSERT INTO notifications (user_id, type, message, related_entity_type, related_entity_id)
         VALUES (:user_id, 'announcement', :message, :related_type, :related_id)"
    );
    $insertNotice->execute([
        'user_id' => $userId,
        'message' => json_encode([
            'title' => 'Announcement Sync Test Event has been announced',
            'detail' => 'Test Venue - 2099-01-01 at 08:00',
        ], JSON_THROW_ON_ERROR),
        'related_type' => 'announcement:event',
        'related_id' => $eventId,
    ]);
    $noticeId = (int) $db->lastInsertId();
    $notificationIds[] = $noticeId;

    // A general announcement must survive the orphan filter.
    $insertNotice->execute([
        'user_id' => $userId,
        'message' => json_encode([
            'title' => 'General campus notice',
            'detail' => 'Not tied to an event.',
        ], JSON_THROW_ON_ERROR),
        'related_type' => null,
        'related_id' => null,
    ]);
    $generalId = (int) $db->lastInsertId();
    $notificationIds[] = $generalId;

    // Simulate the old-build orphan: announcement points at a missing event.
    $orphanEventId = 2147483000;
    $insertNotice->execute([
        'user_id' => $userId,
        'message' => json_encode([
            'title' => 'Orphaned announcement',
            'detail' => 'Its event was deleted.',
        ], JSON_THROW_ON_ERROR),
        'related_type' => 'announcement:event',
        'related_id' => $orphanEventId,
    ]);
    $orphanId = (int) $db->lastInsertId();
    $notificationIds[] = $orphanId;

    $repo = new Repository($db);

    test('event announcement is returned while its event exists', function () use ($repo, $userId): void {
        $titles = announcement_titles($repo->listAnnouncements($userId));
        if (!in_array('Announcement Sync Test Event has been announced', $titles, true)) {
            throw new RuntimeException('the linked announcement was not returned');
        }
    });

    test('general announcement is returned', function () use ($repo, $userId): void {
        $titles = announcement_titles($repo->listAnnouncements($userId));
        if (!in_array('General campus notice', $titles, true)) {
            throw new RuntimeException('the general announcement was not returned');
        }
    });

    test('orphaned event announcement is hidden', function () use ($repo, $userId): void {
        $titles = announcement_titles($repo->listAnnouncements($userId));
        if (in_array('Orphaned announcement', $titles, true)) {
            throw new RuntimeException('an announcement for a missing event was returned');
        }
    });

    test('deleting an event removes its announcement rows', function () use ($repo, $db, $eventId, $noticeId): void {
        $repo->deleteEvent($eventId);

        $eventCheck = $db->prepare('SELECT COUNT(*) FROM events WHERE id = :id');
        $eventCheck->execute(['id' => $eventId]);
        same(0, (int) $eventCheck->fetchColumn());

        $noticeCheck = $db->prepare('SELECT COUNT(*) FROM notifications WHERE id = :id');
        $noticeCheck->execute(['id' => $noticeId]);
        same(0, (int) $noticeCheck->fetchColumn());
    });

    test('deleted event no longer appears in announcements', function () use ($repo, $userId): void {
        $titles = announcement_titles($repo->listAnnouncements($userId));
        if (in_array('Announcement Sync Test Event has been announced', $titles, true)) {
            throw new RuntimeException('the deleted event announcement was still returned');
        }
    });
} catch (Throwable $e) {
    $failed++;
    fwrite(STDERR, '  FAIL  setup -> ' . $e->getMessage() . "\n");
} finally {
    try {
        if ($eventIds !== []) {
            $placeholders = implode(',', array_fill(0, count($eventIds), '?'));
            $cleanup = $db->prepare(
                "DELETE FROM audit_logs WHERE table_name = 'events' AND record_id IN (" . $placeholders . ')'
            );
            $cleanup->execute($eventIds);
        }
        if ($notificationIds !== []) {
            $placeholders = implode(',', array_fill(0, count($notificationIds), '?'));
            $cleanup = $db->prepare('DELETE FROM notifications WHERE id IN (' . $placeholders . ')');
            $cleanup->execute($notificationIds);
        }
        if ($eventIds !== []) {
            $placeholders = implode(',', array_fill(0, count($eventIds), '?'));
            $cleanup = $db->prepare('DELETE FROM events WHERE id IN (' . $placeholders . ')');
            $cleanup->execute($eventIds);
        }
    } catch (Throwable $e) {
        fwrite(STDERR, 'cleanup warning: ' . $e->getMessage() . "\n");
    }
}

fwrite(STDOUT, "\n");
if ($failed === 0) {
    fwrite(STDOUT, "All {$passed} announcement-sync assertions passed.\n");
    exit(0);
}

fwrite(STDERR, "{$failed} announcement-sync assertion(s) failed.\n");
exit(1);

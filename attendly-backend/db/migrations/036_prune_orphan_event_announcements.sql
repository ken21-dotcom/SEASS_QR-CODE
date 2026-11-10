-- Migration 036: prune announcements for deleted events
--
-- 002/006 store an event announcement as a notification row with
-- related_entity_type = 'announcement:event' and a loose related_entity_id.
-- There is no foreign key on that column, so old builds that deleted an
-- event left its announcement rows behind; the student dashboard then showed
-- an announcement that had no matching row in `events`.
--
-- New deletes remove these rows transactionally (Repository::deleteEvent).
-- This migration repairs data created before that fix.

DELETE FROM notifications
 WHERE type = 'announcement'
   AND related_entity_type = 'announcement:event'
   AND NOT EXISTS (
       SELECT 1 FROM events e WHERE e.id = notifications.related_entity_id
   );

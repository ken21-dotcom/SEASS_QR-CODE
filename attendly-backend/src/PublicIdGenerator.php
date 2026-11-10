<?php
/**
 * ATTENDLY — Public display identifiers
 *
 * Generates the human-facing public_id values stored alongside the numeric
 * primary keys. The numeric keys stay internal: every foreign key still
 * references users(id) / events(id), while screens and exports show values
 * such as STUD_007, SSC_003 and EVNT_012.
 */

declare(strict_types=1);

namespace Attendly;

use InvalidArgumentException;
use PDO;
use PDOException;

final class PublicIdGenerator
{
    /** Database role → public-id prefix. */
    private const ROLE_PREFIXES = [
        'student'       => 'STUD',
        'ssc_officer'   => 'SSC',
        'administrator' => 'USR',
    ];

    /** Prefix used for events. */
    private const EVENT_PREFIX = 'EVNT';

    /** Tables that own a public_id column. */
    private const TABLES = [
        'users'  => 'public_id',
        'events' => 'public_id',
    ];

    /**
     * Resolve the prefix for a database role. Unknown roles fall back to the
     * generic user prefix rather than producing an unusable identifier.
     */
    public static function prefixForRole(string $role): string
    {
        $role = strtolower(trim($role));

        return self::ROLE_PREFIXES[$role] ?? 'USR';
    }

    /** Next public ID for a user with the given database role. */
    public static function nextForUser(PDO $db, string $role, int $offset = 0): string
    {
        return self::next($db, 'users', self::prefixForRole($role), $offset);
    }

    /** Next public ID for an event. */
    public static function nextForEvent(PDO $db, int $offset = 0): string
    {
        return self::next($db, 'events', self::EVENT_PREFIX, $offset);
    }

    /**
     * Generate a public id and run $insert with it, retrying when a concurrent
     * request claimed the same suffix first.
     *
     * The suffix is derived from MAX(suffix) + 1 outside any lock, so two
     * simultaneous inserts can compute the same value; the loser gets MySQL
     * duplicate-key error 1062 from the unique public_id index. Each retry asks
     * for a suffix one higher, which is free by definition, so the loser takes
     * the next identifier instead of failing the request with a 500.
     *
     * @param callable(int):string $generate receives the retry offset, returns a public id
     * @param callable(string):mixed $insert performs the insert, returns its result
     */
    public static function insertWithRetry(callable $generate, callable $insert, int $attempts = 3): mixed
    {
        $attempts = max(1, $attempts);

        for ($attempt = 0; $attempt < $attempts; $attempt++) {
            $publicId = $generate($attempt);
            try {
                return $insert($publicId);
            } catch (PDOException $e) {
                // Any other duplicate (email, student number) is a real business
                // conflict and must reach the caller unchanged.
                if ($attempt === $attempts - 1 || !self::isPublicIdCollision($e)) {
                    throw $e;
                }
            }
        }

        // Not reachable: the loop returns or throws on every iteration.
        throw new InvalidArgumentException('Public-id generation exhausted its retries.');
    }

    /**
     * Generate the next sequential identifier for a table + prefix.
     *
     * The sequence is derived from the highest numeric suffix already stored
     * for that prefix, not from COUNT(*), so deleting a row can never cause a
     * future insert to reuse an identifier that was already issued.
     */
    public static function next(PDO $db, string $table, string $prefix, int $offset = 0): string
    {
        if (!isset(self::TABLES[$table])) {
            throw new InvalidArgumentException('Unsupported public-id table: ' . $table);
        }
        if (preg_match('/^[A-Z]{2,6}$/', $prefix) !== 1) {
            throw new InvalidArgumentException('Invalid public-id prefix: ' . $prefix);
        }

        // The prefix is validated above and the table comes from a hard-coded
        // allowlist, so both are safe to interpolate. The suffix starts after
        // "PREFIX_" (1-based in MySQL's SUBSTRING).
        $offset = strlen($prefix) + 2;
        $stmt = $db->prepare(
            'SELECT COALESCE(MAX(CAST(SUBSTRING(public_id, ' . $offset . ') AS UNSIGNED)), 0)
             FROM ' . $table . '
             WHERE public_id LIKE :pattern'
        );
        $stmt->execute(['pattern' => $prefix . '\\_%']);

        $next = (int) $stmt->fetchColumn() + 1 + max(0, $offset);

        return $prefix . '_' . str_pad((string) $next, 3, '0', STR_PAD_LEFT);
    }

    /**
     * True when the driver rejected the row because another request had already
     * taken the same public_id (1062 on the public_id unique index).
     */
    private static function isPublicIdCollision(PDOException $e): bool
    {
        if ((int) ($e->errorInfo[1] ?? 0) !== 1062) {
            return false;
        }

        return str_contains(strtolower((string) $e->getMessage()), 'public_id');
    }
}

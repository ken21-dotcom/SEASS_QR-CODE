<?php

declare(strict_types=1);

namespace Attendly;

/**
 * Issues and verifies event-scoped student check-in QR tokens.
 *
 * A token is stateless: it embeds the student id and event id and carries an
 * HMAC-SHA256 signature over both. The server can therefore verify a scan
 * without storing one row per student/event pair, while a token issued for
 * one event can never be replayed at another.
 *
 * Format: v1.<studentId>.<eventId>.<43-char base64url signature>
 */
final class QrToken
{
    public const VERSION = 'v1';
    public const SIGNATURE_LENGTH = 43;

    /** Shape check only; the signature is verified separately. */
    public const PATTERN = '/^v1\.(\d{1,10})\.(\d{1,10})\.([A-Za-z0-9_-]{43})$/';

    /**
     * Build the deterministic token for one student at one event.
     *
     * @throws \InvalidArgumentException when the signing secret is too weak
     */
    public static function generateEventToken(int $studentId, int $eventId, string $secret): string
    {
        if ($studentId < 1 || $eventId < 1) {
            throw new \InvalidArgumentException('Student and event ids must be positive.');
        }
        if (strlen($secret) < 32) {
            throw new \InvalidArgumentException('The QR signing secret must be at least 32 characters.');
        }

        $payload = self::payload($studentId, $eventId);
        return $payload . '.' . self::sign($payload, $secret);
    }

    /**
     * Verify a token's signature and return the ids it was issued for.
     *
     * Returns null for malformed, forged, or wrong-secret tokens so callers
     * can answer with one generic invalid-QR response.
     *
     * @return array{studentId:int,eventId:int}|null
     */
    public static function parseEventToken(string $token, string $secret): ?array
    {
        if (strlen($secret) < 32 || preg_match(self::PATTERN, $token, $matches) !== 1) {
            return null;
        }

        $studentId = (int) $matches[1];
        $eventId   = (int) $matches[2];
        if ($studentId < 1 || $eventId < 1) {
            return null;
        }

        $payload  = self::payload($studentId, $eventId);
        $expected = self::sign($payload, $secret);
        if (!hash_equals($expected, $matches[3])) {
            return null;
        }

        return ['studentId' => $studentId, 'eventId' => $eventId];
    }

    /**
     * Reject anything that is not shaped like an event token before the
     * database or HMAC path does any work.
     */
    public static function isValid(string $token): bool
    {
        if (preg_match(self::PATTERN, $token, $matches) !== 1) {
            return false;
        }
        return (int) $matches[1] > 0 && (int) $matches[2] > 0;
    }

    private static function payload(int $studentId, int $eventId): string
    {
        return self::VERSION . '.' . $studentId . '.' . $eventId;
    }

    private static function sign(string $payload, string $secret): string
    {
        $raw = hash_hmac('sha256', $payload, $secret, true);
        // Base64url: the second strtr() argument is the two-character
        // replacement for the two-character search string. Passing a full
        // alphabet here would map "+" to "A" and "/" to "B" and quietly
        // shrink the signature alphabet.
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }
}

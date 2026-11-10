<?php

declare(strict_types=1);

namespace Attendly;

use PDO;

final class RateLimiter
{
    public function __construct(private PDO $db)
    {
    }

    public function consume(string $scope, string $subject, int $limit, int $windowSeconds): void
    {
        $limit = max(1, min(10000, $limit));
        $windowSeconds = max(1, min(86400, $windowSeconds));
        $key = hash('sha256', $scope . "\0" . $subject);
        $sql = 'INSERT INTO api_rate_limits (bucket_hash, window_started_at, hit_count)
                VALUES (:bucket, NOW(), 1)
                ON DUPLICATE KEY UPDATE
                    hit_count = IF(window_started_at <= DATE_SUB(NOW(), INTERVAL ' . $windowSeconds . ' SECOND), 1, hit_count + 1),
                    window_started_at = IF(window_started_at <= DATE_SUB(NOW(), INTERVAL ' . $windowSeconds . ' SECOND), NOW(), window_started_at)';
        $stmt = $this->db->prepare($sql);
        $stmt->execute(['bucket' => $key]);

        $read = $this->db->prepare('SELECT hit_count FROM api_rate_limits WHERE bucket_hash = :bucket');
        $read->execute(['bucket' => $key]);
        if ((int) $read->fetchColumn() > $limit) {
            Response::fail('rate_limited', 'Too many requests. Try again later.', 429);
        }

        // Keep the table bounded without a scheduled cleanup dependency.
        if (random_int(1, 100) === 1) {
            $this->db->exec('DELETE FROM api_rate_limits WHERE window_started_at < DATE_SUB(NOW(), INTERVAL 1 DAY) LIMIT 500');
        }
    }
}

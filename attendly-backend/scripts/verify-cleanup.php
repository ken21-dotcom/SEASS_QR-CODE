<?php
require __DIR__ . '/../config/db.php';
$pdo = get_db();
foreach (['users', 'students', 'events', 'attendance_records', 'job_queue'] as $table) {
    try {
        $count = $pdo->query('SELECT COUNT(*) FROM `' . str_replace('`', '', $table) . '`')->fetchColumn();
        echo $table . '=' . $count . PHP_EOL;
    } catch (Throwable $e) {
        echo $table . '=not present' . PHP_EOL;
    }
}
echo 'USERS:' . PHP_EOL;
foreach ($pdo->query('SELECT id, email, role FROM users ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) as $user) {
    echo $user['id'] . ' | ' . $user['email'] . ' | ' . $user['role'] . PHP_EOL;
}

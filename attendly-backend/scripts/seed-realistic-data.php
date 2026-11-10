<?php
/**
 * ATTENDLY — Realistic UI/UX seed data
 *
 * CLI:  php scripts/seed-realistic-data.php
 *
 * Populates the local database with a realistic data set for UI/UX testing:
 *   - 1 administrator
 *   - 3 approved SSC officers
 *   - 30 active students across SCS, SON and SBM
 *     (BSIT, BSN, BSEntrep, BSHM, BSTM)
 *   - 7 events: 1 major event with AM/PM attendance, 4 completed
 *     mandatory minor events (including two flag raisings), 1 live now,
 *     2 upcoming
 *   - attendance records with check-in and check-out timestamps so the
 *     semester matrix has realistic checks and blanks
 *
 * Idempotent by design. Seed accounts are matched by their reserved
 * @attendly.test addresses, events by their display names, attendance by
 * event + student,  Re-running refreshes
 * the same seeded rows rather than creating duplicates. Legacy [SEED]/[DEMO]
 * markers are stripped before matching.
 *
 * Only rows created by this script are touched. Everything runs in one
 * transaction, so a failure leaves the database unchanged.
 *
 * Passwords use PHP's password_hash()/PASSWORD_DEFAULT. PublicIdGenerator and
 * Validator are reused so IDs and field formats match the API.
 */

declare(strict_types=1);

use Attendly\PublicIdGenerator;
use Attendly\Validator;

require __DIR__ . '/../config/db.php';
require __DIR__ . '/../src/PublicIdGenerator.php';
require __DIR__ . '/../src/Validator.php';

const SEED_DOMAIN      = 'attendly.test';
const STUDENT_PASSWORD = 'Student123!';
const OFFICER_PASSWORD = 'Officer123!';
const ADMIN_PASSWORD   = 'Admin123!';

function out(string $message): void
{
    fwrite(STDOUT, $message . PHP_EOL);
}

/**
 * Remove legacy [SEED]/[DEMO] markers from every text column in the schema.
 * Runs inside the seed transaction before rows are matched, so previously
 * tagged events are renamed in place instead of being treated as new.
 *
 * @return int number of rows changed
 */
function strip_demo_tags(PDO $db): int
{
    $schema = (string) $db->query('SELECT DATABASE()')->fetchColumn();
    if ($schema === '') {
        return 0;
    }

    $columns = $db->prepare(
        "SELECT c.TABLE_NAME, c.COLUMN_NAME
           FROM information_schema.COLUMNS c
           JOIN information_schema.TABLES t
             ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
            AND t.TABLE_NAME = c.TABLE_NAME
          WHERE c.TABLE_SCHEMA = :schema
            AND t.TABLE_TYPE = 'BASE TABLE'
            AND c.DATA_TYPE IN ('char','varchar','tinytext','text','mediumtext','longtext')
          ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"
    );
    $columns->execute(['schema' => $schema]);

    $changed = 0;
    foreach ($columns->fetchAll() as $column) {
        $table = str_replace('`', '``', (string) $column['TABLE_NAME']);
        $field = str_replace('`', '``', (string) $column['COLUMN_NAME']);
        $sql = sprintf(
            "UPDATE `%s`
                SET `%s` = TRIM(REPLACE(REPLACE(REPLACE(REPLACE(`%s`, '[SEED] ', ''), '[DEMO] ', ''), '[SEED]', ''), '[DEMO]', ''))
              WHERE `%s` LIKE '%%[SEED]%%' OR `%s` LIKE '%%[DEMO]%%'",
            $table,
            $field,
            $field,
            $field,
            $field
        );
        $changed += $db->exec($sql);
    }

    return $changed;
}

/* ── Accounts ─────────────────────────────────────────────────── */

/** @return array<string,mixed>|false */
function find_user_by_email(PDO $db, string $email): array|false
{
    $stmt = $db->prepare(
        'SELECT id, public_id, role, email, display_name
         FROM users WHERE email = :email LIMIT 1'
    );
    $stmt->execute(['email' => $email]);
    return $stmt->fetch();
}

/**
 * Create or refresh a seed account. Existing seed accounts keep their public
 * ID and QR token; their known test password and active status are restored.
 *
 * @param array{role:string,email:string,displayName:string,password:string} $spec
 * @return array{id:int,publicId:string,created:bool}
 */
function ensure_seed_user(PDO $db, array $spec): array
{
    $email       = Validator::email($spec['email']);
    $displayName = Validator::name($spec['displayName']);
    Validator::password($spec['password']);

    $existing = find_user_by_email($db, $email);
    if ($existing !== false) {
        if ((string) $existing['role'] !== $spec['role']) {
            throw new RuntimeException(sprintf(
                'Refusing to touch %s: it exists with role "%s", expected "%s".',
                $email,
                (string) $existing['role'],
                $spec['role']
            ));
        }

        $update = $db->prepare(
            "UPDATE users
             SET display_name = :display_name,
                 password_hash = :password_hash,
                 status = 'active',
                 must_change_password = 0
             WHERE id = :id"
        );
        $update->execute([
            'display_name'  => $displayName,
            'password_hash' => password_hash($spec['password'], PASSWORD_DEFAULT),
            'id'            => (int) $existing['id'],
        ]);

        return [
            'id'       => (int) $existing['id'],
            'publicId' => (string) $existing['public_id'],
            'created'  => false,
        ];
    }

    $publicId = PublicIdGenerator::nextForUser($db, $spec['role']);
    $insert   = $db->prepare(
        "INSERT INTO users
            (public_id, role, email, display_name, password_hash, status, must_change_password)
         VALUES
            (:public_id, :role, :email, :display_name, :password_hash, 'active', 0)"
    );
    $insert->execute([
        'public_id'    => $publicId,
        'role'         => $spec['role'],
        'email'        => $email,
        'display_name' => $displayName,
        'password_hash'=> password_hash($spec['password'], PASSWORD_DEFAULT),
    ]);

    return [
        'id'       => (int) $db->lastInsertId(),
        'publicId' => $publicId,
        'created'  => true,
    ];
}

/**
 * @param array{email:string,firstName:string,lastName:string} $admin
 * @return array{id:int,publicId:string,created:bool}
 */
function ensure_seed_admin(PDO $db, array $admin): array
{
    Validator::name($admin['firstName']);
    Validator::name($admin['lastName']);

    $user = ensure_seed_user($db, [
        'role'        => 'administrator',
        'email'       => $admin['email'],
        'displayName' => $admin['firstName'] . ' ' . $admin['lastName'],
        'password'    => ADMIN_PASSWORD,
    ]);

    $db->prepare('INSERT IGNORE INTO administrators (user_id) VALUES (:uid)')
        ->execute(['uid' => $user['id']]);

    return $user;
}

/**
 * @param array{email:string,firstName:string,lastName:string,position:string} $officer
 * @return array{id:int,publicId:string,created:bool}
 */
function ensure_seed_officer(PDO $db, array $officer, int $adminId, string $approvedAt): array
{
    Validator::name($officer['firstName']);
    Validator::name($officer['lastName']);

    $user = ensure_seed_user($db, [
        'role'        => 'ssc_officer',
        'email'       => $officer['email'],
        'displayName' => $officer['firstName'] . ' ' . $officer['lastName'],
        'password'    => OFFICER_PASSWORD,
    ]);

    $existing = $db->prepare('SELECT 1 FROM ssc_officers WHERE user_id = :uid LIMIT 1');
    $existing->execute(['uid' => $user['id']]);

    if ($existing->fetchColumn() !== false) {
        $update = $db->prepare(
            "UPDATE ssc_officers
             SET position = :position,
                 approved_by = :approved_by,
                 approved_at = COALESCE(approved_at, :approved_at),
                 status = 'approved'
             WHERE user_id = :uid"
        );
        $update->execute([
            'position'    => $officer['position'],
            'approved_by' => $adminId,
            'approved_at' => $approvedAt,
            'uid'         => $user['id'],
        ]);
    } else {
        $insert = $db->prepare(
            "INSERT INTO ssc_officers (user_id, position, approved_by, approved_at, status)
             VALUES (:uid, :position, :approved_by, :approved_at, 'approved')"
        );
        $insert->execute([
            'uid'         => $user['id'],
            'position'    => $officer['position'],
            'approved_by' => $adminId,
            'approved_at' => $approvedAt,
        ]);
    }

    return $user;
}

/** Return the user who already owns a student ID number, or false. */
function find_student_id_owner(PDO $db, string $studentIdNumber): int|false
{
    $stmt = $db->prepare(
        'SELECT user_id FROM students WHERE student_id_number = :student_id_number LIMIT 1'
    );
    $stmt->execute(['student_id_number' => $studentIdNumber]);
    $owner = $stmt->fetchColumn();
    return $owner === false ? false : (int) $owner;
}

/** Find the next free YYYY-NNNNN in the reserved seed range. */
function allocate_student_id(PDO $db, string $candidate, int $userId): string
{
    [$year, $serial] = explode('-', $candidate);
    $number = (int) $serial;

    while ($number <= 99999) {
        $next = sprintf('%s-%05d', $year, $number);
        $owner = find_student_id_owner($db, $next);
        if ($owner === false || $owner === $userId) {
            Validator::studentIdNumber($next);
            return $next;
        }
        $number++;
    }

    throw new RuntimeException('Could not allocate a unique student ID number.');
}

/**
 * @param array{email:string,firstName:string,lastName:string,studentIdNumber:string,department:string,program:string,yearLevel:string,block:string} $student
 * @return array{id:int,publicId:string,studentIdNumber:string,name:string,email:string,department:string,program:string,yearLevel:string,block:string,created:bool}
 */
function ensure_seed_student(
    PDO $db,
    array $student,
    int $adminId,
    string $approvedAt
): array {
    $firstName = Validator::name($student['firstName']);
    $lastName  = Validator::name($student['lastName']);
    $fullName  = $firstName . ' ' . $lastName;

    $user = ensure_seed_user($db, [
        'role'        => 'student',
        'email'       => $student['email'],
        'displayName' => $fullName,
        'password'    => STUDENT_PASSWORD,
    ]);

    $existing = $db->prepare(
        'SELECT student_id_number FROM students WHERE user_id = :uid LIMIT 1'
    );
    $existing->execute(['uid' => $user['id']]);
    $existingId = $existing->fetchColumn();

    if ($existingId !== false) {
        $studentIdNumber = (string) $existingId;
    } else {
        $desired = Validator::studentIdNumber($student['studentIdNumber']);
        $studentIdNumber = allocate_student_id($db, $desired, $user['id']);
    }

    $profile = $db->prepare(
        'INSERT INTO students
            (user_id, student_id_number, first_name, last_name, department,
             program, year_level, block, approved_by, approved_at)
         VALUES
            (:uid, :student_id_number, :first_name, :last_name, :department,
             :program, :year_level, :block, :approved_by, :approved_at)
         ON DUPLICATE KEY UPDATE
            student_id_number = VALUES(student_id_number),
            first_name = VALUES(first_name),
            last_name = VALUES(last_name),
            department = VALUES(department),
            program = VALUES(program),
            year_level = VALUES(year_level),
            block = VALUES(block),
            approved_by = VALUES(approved_by),
            approved_at = COALESCE(approved_at, VALUES(approved_at))'
    );
    $profile->execute([
        'uid'               => $user['id'],
        'student_id_number' => $studentIdNumber,
        'first_name'        => $firstName,
        'last_name'         => $lastName,
        'department'        => $student['department'],
        'program'           => $student['program'],
        'year_level'        => $student['yearLevel'],
        'block'           => $student['block'],
        'approved_by'       => $adminId,
        'approved_at'       => $approvedAt,
    ]);

    return [
        'id'              => $user['id'],
        'publicId'        => $user['publicId'],
        'studentIdNumber' => $studentIdNumber,
        'name'            => $fullName,
        'email'           => strtolower($student['email']),
        'department'      => $student['department'],
        'program'         => $student['program'],
        'yearLevel'       => $student['yearLevel'],
        'block'         => $student['block'],
        'created'         => $user['created'],
    ];
}

/* ── Events ───────────────────────────────────────────────────── */

/**
 * @param array{name:string,description:string,date:string,start:string,end:string,venue:string,type:string,category:string,status:string} $event
 * @return array{id:int,publicId:string,created:bool}
 */
function ensure_seed_event(PDO $db, int $creatorId, array $event): array
{
    if (!in_array($event['type'], ['mandatory', 'optional'], true)) {
        throw new RuntimeException('Invalid seed event type: ' . $event['type']);
    }
    if (!in_array($event['category'], ['major', 'minor'], true)) {
        throw new RuntimeException('Invalid seed event category: ' . $event['category']);
    }
    if (!in_array($event['status'], ['scheduled', 'completed', 'cancelled'], true)) {
        throw new RuntimeException('Invalid seed event status: ' . $event['status']);
    }

    $find = $db->prepare('SELECT id, public_id FROM events WHERE name = :name LIMIT 1');
    $find->execute(['name' => $event['name']]);
    $existing = $find->fetch();

    if ($existing !== false) {
        $update = $db->prepare(
            'UPDATE events
             SET description = :description,
                 event_date = :event_date,
                 start_time = :start_time,
                 end_time = :end_time,
                 checkout_open_minutes = 60,
                 checkout_close_minutes = 60,
                 venue = :venue,
                 event_type = :event_type,
                 event_category = :event_category,
                 status = :status,
                 created_by = :created_by
             WHERE id = :id'
        );
        $update->execute([
            'description'    => $event['description'],
            'event_date'     => $event['date'],
            'start_time'     => $event['start'],
            'end_time'       => $event['end'],
            'venue'          => $event['venue'],
            'event_type'     => $event['type'],
            'event_category' => $event['category'],
            'status'         => $event['status'],
            'created_by'     => $creatorId,
            'id'             => (int) $existing['id'],
        ]);

        return [
            'id'       => (int) $existing['id'],
            'publicId' => (string) $existing['public_id'],
            'created'  => false,
        ];
    }

    $publicId = PublicIdGenerator::nextForEvent($db);
    $insert = $db->prepare(
        'INSERT INTO events
            (public_id, name, description, event_date, start_time, end_time,
             checkout_open_minutes, checkout_close_minutes, venue, event_type,
             event_category, status, created_by)
         VALUES
            (:public_id, :name, :description, :event_date, :start_time, :end_time,
             60, 60, :venue, :event_type, :event_category, :status, :created_by)'
    );
    $insert->execute([
        'public_id'      => $publicId,
        'name'           => $event['name'],
        'description'    => $event['description'],
        'event_date'     => $event['date'],
        'start_time'     => $event['start'],
        'end_time'       => $event['end'],
        'venue'          => $event['venue'],
        'event_type'     => $event['type'],
        'event_category' => $event['category'],
        'status'         => $event['status'],
        'created_by'     => $creatorId,
    ]);

    return [
        'id'       => (int) $db->lastInsertId(),
        'publicId' => $publicId,
        'created'  => true,
    ];
}

/* ── Attendance ─────────────────────────────────── */

/**
 * Insert a check-in or refresh the existing seed check-in.
 *
 * @return int 1 when inserted, 2 when updated, 0 when unchanged
 */
function upsert_attendance(
    PDO $db,
    int $eventId,
    int $studentId,
    string $checkInTime,
    string $method,
    ?string $checkOutTime = null
): int {
    $stmt = $db->prepare(
        'INSERT INTO attendance_records
            (event_id, student_id, check_in_time, check_out_time, verification_method)
         VALUES
            (:event_id, :student_id, :check_in_time, :check_out_time, :method)
         ON DUPLICATE KEY UPDATE
            check_in_time = VALUES(check_in_time),
            check_out_time = VALUES(check_out_time),
            verification_method = VALUES(verification_method)'
    );
    $stmt->execute([
        'event_id'       => $eventId,
        'student_id'     => $studentId,
        'check_in_time'  => $checkInTime,
        'check_out_time' => $checkOutTime,
        'method'         => $method,
    ]);
    return $stmt->rowCount();
}

/**
 * @param array<int,array<string,mixed>> $students
 * @return array<string,mixed>
 */
function find_seed_student(array $students, string $name): array
{
    foreach ($students as $student) {
        if ((string) $student['name'] === $name) {
            return $student;
        }
    }

    throw new RuntimeException('Seed student not found: ' . $name);
}

/**
 * Deterministic shuffle so reruns pick the same students for each event.
 *
 * @param array<int,array<string,mixed>> $students
 * @return array<int,array<string,mixed>>
 */
function pick_students(array $students, string $seed, int $count): array
{
    $pool = array_values($students);
    mt_srand(crc32($seed));
    for ($i = count($pool) - 1; $i > 0; $i--) {
        $j = mt_rand(0, $i);
        [$pool[$i], $pool[$j]] = [$pool[$j], $pool[$i]];
    }
    return array_slice($pool, 0, min($count, count($pool)));
}

/* ── Main ─────────────────────────────────────────────────────── */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This script can only be run from the command line.\n");
    exit(1);
}

$db = null;
try {
    $config = require __DIR__ . '/../config/config.php';
    $timezone = new DateTimeZone((string) ($config['tunables']['timezone'] ?? 'Asia/Manila'));
    $now = new DateTimeImmutable('now', $timezone);
    $today = $now->setTime(0, 0, 0);
    $nowSql = $now->format('Y-m-d H:i:s');

    $db = get_db();
    $db->beginTransaction();

    out('ATTENDLY realistic data seeder');
    out('Database: ' . $config['db']['dbname'] . ' @ ' . $config['db']['host']);

    $tagsRemoved = strip_demo_tags($db);
    out(sprintf('Legacy markers removed from %d row(s).', $tagsRemoved));
    out('');

    /* Accounts ------------------------------------------------- */

    $admin = ensure_seed_admin($db, [
        'email'     => 'admin@' . SEED_DOMAIN,
        'firstName' => 'Seed',
        'lastName'  => 'Administrator',
    ]);

    $officerDefs = [
        ['firstName' => 'Ramon',  'lastName' => 'Villareal', 'position' => 'Chairperson',      'email' => 'ramon.villareal@' . SEED_DOMAIN],
        ['firstName' => 'Grace',  'lastName' => 'Manansala', 'position' => 'Vice Chairperson', 'email' => 'grace.manansala@' . SEED_DOMAIN],
        ['firstName' => 'Jerome', 'lastName' => 'Bacani',    'position' => 'Secretary',        'email' => 'jerome.bacani@' . SEED_DOMAIN],
    ];

    $officers = [];
    foreach ($officerDefs as $officer) {
        $officers[] = ensure_seed_officer($db, $officer, $admin['id'], $nowSql);
    }

    $namePairs = [
        ['Maria', 'Santos'],
        ['Juan', 'Dela Cruz'],
        ['Jose', 'Reyes'],
        ['Ana', 'Bautista'],
        ['Miguel', 'Garcia'],
        ['Sofia', 'Mendoza'],
        ['Paolo', 'Ramos'],
        ['Angela', 'Villanueva'],
        ['Carlo', 'Aquino'],
        ['Bea', 'Domingo'],
        ['Gabriel', 'Navarro'],
        ['Liza', 'Fernandez'],
        ['Mark', 'Castillo'],
        ['Nicole', 'Salazar'],
        ['Daniel', 'Pascual'],
        ['Patricia', 'Mercado'],
        ['Joshua', 'Lim'],
        ['Kristine', 'Tan'],
        ['Rafael', 'Soriano'],
        ['Jasmine', 'Cruz'],
        ['Emmanuel', 'Rivera'],
        ['Camille', 'Flores'],
        ['Aaron', 'Gonzales'],
        ['Althea', 'Manalo'],
        ['Francis', 'Abad'],
        ['Rina', 'Valdez'],
        ['Victorino', 'Padilla'],
        ['Bianca', 'Roxas'],
        ['Nathaniel', 'Sy'],
        ['Erika', 'Chua'],
    ];

    // JHCSC Pagadian scope: only these three schools and five programs.
    // Department names match ProgramCatalog and the UI taxonomy so grouped
    // views, filters, and reports recognise every seeded student.
    $programs = [
        ['department' => 'School of Computer Studies',    'program' => 'BSIT'],
        ['department' => 'School of Nursing',             'program' => 'BSN'],
        ['department' => 'School of Business Management', 'program' => 'BSEntrep'],
        ['department' => 'School of Business Management', 'program' => 'BSHM'],
        ['department' => 'School of Business Management', 'program' => 'BSTM'],
    ];

    $currentYear = (int) $now->format('Y');
    $usedEmails = [];
    $students = [];

    foreach ($namePairs as $index => [$firstName, $lastName]) {
        $yearLevel = (string) (($index % 4) + 1);
        $programDef = $programs[$index % count($programs)];

        $slug = strtolower((string) preg_replace('/[^a-z0-9]+/i', '.', $firstName . ' ' . $lastName));
        $slug = trim($slug, '.');
        $email = $slug . '@' . SEED_DOMAIN;
        if (isset($usedEmails[$email])) {
            $email = $slug . ($index + 1) . '@' . SEED_DOMAIN;
        }
        $usedEmails[$email] = true;

        $students[] = ensure_seed_student($db, [
            'email'           => $email,
            'firstName'       => $firstName,
            'lastName'        => $lastName,
            'studentIdNumber' => sprintf('%04d-%05d', $currentYear - ($yearLevel - 1), 91001 + $index),
            'department'      => $programDef['department'],
            'program'         => $programDef['program'],
            'yearLevel'       => $yearLevel,
            'block'         => ['A', 'B', 'C'][$index % 3],
        ], $admin['id'], $nowSql);
    }

    /* Events --------------------------------------------------- */

    $liveStart = $now->modify('-20 minutes');
    if ($liveStart < $today) {
        $liveStart = $today;
    }
    $liveEnd = $now->modify('+100 minutes');
    $endOfDay = $today->setTime(23, 59, 0);
    if ($liveEnd > $endOfDay) {
        $liveEnd = $endOfDay;
    }
    if ($liveEnd <= $liveStart) {
        $liveEnd = $liveStart->modify('+30 minutes');
    }

    // Two recent flag raisings keep most of the roster present while leaving
    // deliberate blanks for the matrix. They are minor events but still
    // mandatory, which is exactly why event_category is separate from
    // event_type.
    $flagMondayRoster = array_values(array_map(
        static fn(array $student): string => (string) $student['name'],
        array_filter(
            $students,
            static fn(array $student): bool => !in_array(
                (string) $student['name'],
                ['Gabriel Navarro', 'Daniel Pascual', 'Sofia Mendoza', 'Paolo Ramos', 'Bianca Roxas', 'Erika Chua'],
                true
            )
        )
    ));
    $flagWednesdayRoster = array_values(array_map(
        static fn(array $student): string => (string) $student['name'],
        array_filter(
            $students,
            static fn(array $student): bool => !in_array(
                (string) $student['name'],
                ['Gabriel Navarro', 'Daniel Pascual', 'Paolo Ramos', 'Erika Chua', 'Rina Valdez', 'Joshua Lim'],
                true
            )
        )
    ));

    $eventDefs = [
        [
            'key'         => 'past1',
            'name'        => 'Student Orientation',
            'description' => 'Annual orientation for first-year and transferee students at the Pagadian campus.',
            'date'        => $today->modify('-10 days')->format('Y-m-d'),
            'start'       => '08:00:00',
            'end'         => '12:00:00',
            'venue'       => 'JHCSC Gymnasium',
            'type'        => 'mandatory',
            'category'    => 'minor',
            'status'      => 'completed',
            // Fixed roster keeps attendance (and the sanctions that reference
            // it) stable even when event names or shuffle logic change.
            'roster'      => [
                'Rina Valdez', 'Miguel Garcia', 'Rafael Soriano', 'Nathaniel Sy',
                'Carlo Aquino', 'Camille Flores', 'Althea Manalo', 'Victorino Padilla',
                'Patricia Mercado', 'Jasmine Cruz', 'Erika Chua', 'Angela Villanueva',
                'Joshua Lim', 'Kristine Tan', 'Bea Domingo',
            ],
        ],
        [
            'key'         => 'past2',
            'name'        => 'Acquaintance Party',
            'description' => 'Campus social event welcoming students to the new academic term.',
            'date'        => $today->modify('-4 days')->format('Y-m-d'),
            // A full-day major event so the matrix renders AM In / AM Out /
            // PM In / PM Out instead of a single attendance column.
            'start'       => '08:00:00',
            'end'         => '17:00:00',
            'venue'       => 'Campus Activity Center',
            'type'        => 'mandatory',
            'category'    => 'major',
            'status'      => 'completed',
            'roster'      => [
                'Liza Fernandez', 'Aaron Gonzales', 'Rafael Soriano', 'Bianca Roxas',
                'Kristine Tan', 'Ana Bautista', 'Sofia Mendoza', 'Camille Flores',
                'Miguel Garcia', 'Nicole Salazar', 'Victorino Padilla', 'Emmanuel Rivera',
                'Angela Villanueva', 'Nathaniel Sy', 'Carlo Aquino',
            ],
        ],
        [
            'key'         => 'flag1',
            'name'        => 'Monday Flag Raising',
            'description' => 'Weekly flag-raising ceremony at the Pagadian campus flagpole.',
            'date'        => $today->modify('last monday')->format('Y-m-d'),
            'start'       => '07:00:00',
            'end'         => '07:30:00',
            'venue'       => 'JHCSC Flagpole',
            'type'        => 'mandatory',
            'category'    => 'minor',
            'status'      => 'completed',
            'roster'      => $flagMondayRoster,
        ],
        [
            'key'         => 'flag2',
            'name'        => 'Wednesday Flag Raising',
            'description' => 'Midweek flag-raising ceremony at the Pagadian campus flagpole.',
            'date'        => $today->modify('last wednesday')->format('Y-m-d'),
            'start'       => '07:00:00',
            'end'         => '07:30:00',
            'venue'       => 'JHCSC Flagpole',
            'type'        => 'mandatory',
            'category'    => 'minor',
            'status'      => 'completed',
            'roster'      => $flagWednesdayRoster,
        ],
        [
            'key'         => 'live',
            'name'        => 'Campus Assembly (Live)',
            'description' => 'Live check-in test event. Open the kiosk and use this event now.',
            'date'        => $now->format('Y-m-d'),
            'start'       => $liveStart->format('H:i:s'),
            'end'         => $liveEnd->format('H:i:s'),
            'venue'       => 'JHCSC Main Gymnasium',
            'type'        => 'mandatory',
            'category'    => 'minor',
            'status'      => 'scheduled',
            'roster'      => [
                'Nathaniel Sy', 'Bianca Roxas', 'Mark Castillo', 'Victorino Padilla',
                'Bea Domingo', 'Aaron Gonzales', 'Carlo Aquino', 'Althea Manalo',
                'Gabriel Navarro', 'Joshua Lim', 'Liza Fernandez', 'Daniel Pascual',
                'Rina Valdez', 'Emmanuel Rivera', 'Jose Reyes',
            ],
        ],
        [
            'key'         => 'upcoming1',
            'name'        => 'Research Colloquium',
            'description' => 'Research presentations and project exhibits from all three schools.',
            'date'        => $today->modify('+7 days')->format('Y-m-d'),
            'start'       => '09:00:00',
            'end'         => '16:00:00',
            'venue'       => 'JHCSC Auditorium',
            'type'        => 'mandatory',
            'category'    => 'minor',
            'status'      => 'scheduled',
        ],
        [
            'key'         => 'upcoming2',
            'name'        => 'Sports Fest Opening',
            'description' => 'Opening ceremony for the annual JHCSC sports festival.',
            'date'        => $today->modify('+21 days')->format('Y-m-d'),
            'start'       => '14:00:00',
            'end'         => '17:00:00',
            'venue'       => 'JHCSC Athletic Oval',
            'type'        => 'optional',
            'category'    => 'minor',
            'status'      => 'scheduled',
        ],
    ];

    $events = [];
    foreach ($eventDefs as $eventDef) {
        $stored = ensure_seed_event($db, $officers[0]['id'], $eventDef);
        $events[$eventDef['key']] = $stored + ['definition' => $eventDef];
    }

    /* Attendance ----------------------------------------------- */

    $attendanceStats = ['created' => 0, 'updated' => 0, 'unchanged' => 0];
    $attendanceByEvent = [];
    $attendanceEventKeys = ['past1', 'past2', 'flag1', 'flag2', 'live'];

    foreach ($attendanceEventKeys as $eventKey) {
        $event = $events[$eventKey];
        $definition = $event['definition'];
        $start = new DateTimeImmutable($definition['date'] . ' ' . $definition['start'], $timezone);
        $end = new DateTimeImmutable($definition['date'] . ' ' . $definition['end'], $timezone);
        $selected = [];
        foreach ($definition['roster'] ?? [] as $studentName) {
            $selected[] = find_seed_student($students, $studentName);
        }
        if ($selected === []) {
            $selected = pick_students($students, $definition['key'], 15);
        }
        $attendanceByEvent[$eventKey] = [];

        foreach ($selected as $position => $student) {
            $method = $position % 4 === 3 ? 'manual' : 'qr';
            $isLate = false;
            $checkOut = null;

            if ($eventKey === 'past2') {
                // Major event: a mix of full-day attendees, early leavers and
                // afternoon arrivals so every AM/PM matrix column can show a
                // realistic mixture of checks and blanks.
                if ($position < 10) {
                    $checkIn = $start->modify('-10 minutes')
                        ->modify(sprintf('+%d seconds', $position * 90));
                    $checkOut = $start->setTime(16, 30)
                        ->modify(sprintf('+%d minutes', $position * 2));
                } elseif ($position < 12) {
                    $checkIn = $start->modify('-5 minutes');
                    $checkOut = $start->setTime(11, 20)
                        ->modify(sprintf('+%d minutes', ($position - 10) * 5));
                } else {
                    $checkIn = $start->setTime(13, 5)
                        ->modify(sprintf('+%d minutes', ($position - 12) * 4));
                    $checkOut = $start->setTime(16, 45)
                        ->modify(sprintf('+%d minutes', ($position - 12) * 2));
                }
            } elseif ($eventKey === 'flag1' || $eventKey === 'flag2') {
                $checkIn = $start->modify('-8 minutes')
                    ->modify(sprintf('+%d seconds', $position * 20));
                $checkOut = $end->modify('+5 minutes')
                    ->modify(sprintf('+%d seconds', $position * 10));
            } else {
                $isLate = $position >= 11;
                if ($isLate) {
                    $checkIn = $start->modify(sprintf('+%d minutes', 17 + ($position - 11)));
                } else {
                    $checkIn = $start->modify('-10 minutes')
                        ->modify(sprintf('+%d seconds', $position * 90));
                }

                // The live event is still running, so it has no check-outs.
                // Student Orientation gets check-outs to exercise the
                // attendance print columns.
                if ($eventKey !== 'live') {
                    $checkOut = $start->setTime(11, 30)
                        ->modify(sprintf('+%d minutes', min($position, 20)));
                }
            }

            $result = upsert_attendance(
                $db,
                $event['id'],
                $student['id'],
                $checkIn->format('Y-m-d H:i:s'),
                $method,
                $checkOut?->format('Y-m-d H:i:s')
            );
            if ($result === 1) {
                $attendanceStats['created']++;
            } elseif ($result === 2) {
                $attendanceStats['updated']++;
            } else {
                $attendanceStats['unchanged']++;
            }

            $attendanceByEvent[$eventKey][] = [
                'student'  => $student,
                'method'   => $method,
                'late'     => $isLate,
                'time'     => $checkIn->format('Y-m-d H:i:s'),
                'checkOut' => $checkOut?->format('Y-m-d H:i:s'),
            ];
        }
    }

    $db->commit();

    /* Summary --------------------------------------------------- */

    $ensuredAccounts = 1 + count($officers) + count($students);
    $newAccounts     = ($admin['created'] ? 1 : 0)
        + count(array_filter($officers, static fn(array $u): bool => $u['created']))
        + count(array_filter($students, static fn(array $s): bool => $s['created']));
    $newStudents     = count(array_filter($students, static fn(array $s): bool => $s['created']));
    $newEvents       = count(array_filter($events, static fn(array $e): bool => $e['created']));
    $attendanceTotal = array_sum($attendanceStats);

    out(sprintf(
        'Created/refreshed: %d accounts, %d students, %d events, %d attendance records.',
        $ensuredAccounts,
        count($students),
        count($events),
        $attendanceTotal,
    ));
    out(sprintf(
        'This run: %d accounts new; %d students new; %d events new; attendance %d new / %d refreshed / %d unchanged.',
        $newAccounts,
        $newStudents,
        $newEvents,
        $attendanceStats['created'],
        $attendanceStats['updated'],
        $attendanceStats['unchanged'],
    ));
    out('');

    out('LOGIN ACCOUNTS');
    out(sprintf('  Administrator  %-34s  %s', 'admin@' . SEED_DOMAIN, ADMIN_PASSWORD));
    foreach ($officerDefs as $index => $officer) {
        out(sprintf(
            '  SSC Officer    %-34s  %s  (%s)',
            $officer['email'],
            OFFICER_PASSWORD,
            $officer['position']
        ));
    }
    out(sprintf('  Students       all %d accounts use password: %s', count($students), STUDENT_PASSWORD));
    out('');

    out('EVENTS');
    foreach ($events as $event) {
        $definition = $event['definition'];
        $liveLabel = $event['definition']['key'] === 'live' ? '  <-- LIVE NOW' : '';
        out(sprintf(
            '  %-8s  %-7s  %-10s  %s  %s-%s  %s%s',
            $event['publicId'],
            $definition['category'],
            $definition['status'],
            $definition['date'],
            substr($definition['start'], 0, 5),
            substr($definition['end'], 0, 5),
            $definition['name'],
            $liveLabel
        ));
    }
    out('');

    out('STUDENT ACCOUNTS');
    foreach ($students as $student) {
        out(sprintf(
            '  %-9s  %-11s  %-20s  %-34s  %s / %s / Year %s',
            $student['publicId'],
            $student['studentIdNumber'],
            $student['name'],
            $student['email'],
            $student['department'],
            $student['program'],
            $student['yearLevel']
        ));
    }
    out('');

    out('LIVE EVENT ATTENDEES (already checked in)');
    foreach ($attendanceByEvent['live'] as $entry) {
        out(sprintf(
            '  %-20s  %-34s  %s  %s',
            $entry['student']['name'],
            $entry['student']['email'],
            strtoupper($entry['method']),
            $entry['late'] ? 'late' : 'on-time'
        ));
    }
    out('');

    out('Live event check-in window is open now. Sign in as an officer/admin, open the Kiosk,');
    out('select "' . $events['live']['definition']['name'] . '", then scan a student QR or use manual entry.');
    out('Re-running this script refreshes the same seed rows and does not duplicate them.');
} catch (Throwable $error) {
    if ($db instanceof PDO && $db->inTransaction()) {
        $db->rollBack();
    }
    fwrite(STDERR, 'ERROR: ' . $error->getMessage() . PHP_EOL);
    exit(1);
}

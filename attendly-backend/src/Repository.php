<?php
/**
 * ATTENDLY — Data Access
 *
 * Reads and writes for the entities the frontend needs. Every query
 * uses prepared statements; row shapes are mapped into the camelCase
 * field names js/*.js already expect so the client needs no reshaping.
 */

declare(strict_types=1);

namespace Attendly;

use PDO;
use PDOException;

require_once __DIR__ . '/ProgramCatalog.php';
require_once __DIR__ . '/PublicIdGenerator.php';
require_once __DIR__ . '/QrToken.php';
require_once __DIR__ . '/Mailer.php';

final class Repository
{
    public function __construct(private PDO $db)
    {
    }

    /**
     * Open (and create if needed) the SQLite queue database.
     *
     * The queue is intentionally a second data store: MySQL holds the core
     * business data while SQLite holds the asynchronous job queue. This
     * proves the system spans two data stores.
     *
     * @return PDO
     */
    private function getQueueDb(): PDO
    {
        static $pdo = null;
        if ($pdo !== null) {
            return $pdo;
        }

        $path = __DIR__ . '/../queue.sqlite';
        $pdo = new PDO('sqlite:' . $path);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

        $pdo->exec(<<<'SQL'
            CREATE TABLE IF NOT EXISTS job_queue (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type    TEXT    NOT NULL,
                payload     TEXT    NOT NULL,
                status      TEXT    NOT NULL DEFAULT 'pending',
                attempts    INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        SQL);

        return $pdo;
    }

    /**
     * Enqueue a job into the SQLite queue.
     *
     * @param string $jobType
     * @param array<string,mixed> $payload
     */
    public function enqueueJob(string $jobType, array $payload): int
    {
        $db = $this->getQueueDb();
        $stmt = $db->prepare(
            'INSERT INTO job_queue (job_type, payload, status, attempts)
             VALUES (:job_type, :payload, :status, 0)'
        );
        $stmt->execute([
            'job_type' => $jobType,
            'payload'  => json_encode($payload, JSON_THROW_ON_ERROR),
            'status'   => 'pending',
        ]);
        return (int) $db->lastInsertId();
    }

    /**
     * Write an audit log entry.
     *
     * @param string $action       'create'|'update'|'delete'
     * @param string $tableName    e.g. 'events', 'users', 'sanction_recommendations', 'sanction_records'
     * @param int    $recordId     primary key of the affected row
     * @param array|null $oldValues  JSON-serializable old state (null for create)
     * @param array|null $newValues  JSON-serializable new state (null for delete)
     * @param int|null $userId     actor's user id (from session)
     * @param string|null $ipAddress  client IP
     * @param string|null $userAgent  client user agent
     */
    public function writeAudit(
        string $action,
        string $tableName,
        int $recordId,
        ?array $oldValues = null,
        ?array $newValues = null,
        ?int $userId = null,
        ?string $ipAddress = null,
        ?string $userAgent = null
    ): void {
        // Best-effort: an audit write must never break the transaction it
        // records. If migration 030 has not been applied yet (table missing),
        // the insert is skipped and the caller keeps working.
        try {
            $stmt = $this->db->prepare(
                'INSERT INTO audit_logs (user_id, action, table_name, record_id, old_values, new_values, ip_address, user_agent)
                 VALUES (:user_id, :action, :table_name, :record_id, :old_values, :new_values, :ip_address, :user_agent)'
            );
            $stmt->execute([
                'user_id'     => $userId,
                'action'      => $action,
                'table_name'  => $tableName,
                'record_id'   => $recordId,
                'old_values'  => $oldValues !== null ? json_encode($oldValues, JSON_THROW_ON_ERROR) : null,
                'new_values'  => $newValues !== null ? json_encode($newValues, JSON_THROW_ON_ERROR) : null,
                'ip_address'  => $ipAddress,
                'user_agent'  => $userAgent,
            ]);
        } catch (PDOException $e) {
            // 42S02 = base table or view not found (migration not applied).
            // Any other DB error is surfaced so a real failure is visible.
            if (str_contains((string) ($e->errorInfo[1] ?? ''), '1146')) {
                error_log('[attendly] audit_logs table missing — run php db/migrate.php');
                return;
            }
            throw $e;
        }
    }

    /**
     * List recent audit log entries.
     *
     * @param int $limit
     * @return array<int,array<string,mixed>>
     */
    public function listAuditLogs(int $limit = 50): array
    {
        $sql = 'SELECT al.id, al.user_id, al.action, al.table_name, al.record_id,
                       al.old_values, al.new_values, al.ip_address, al.user_agent,
                       al.created_at,
                       au.email AS actor_email,
                       au.display_name AS actor_name,
                       au.role AS actor_role,
                       COALESCE(
                           NULLIF(TRIM(CONCAT_WS(\' \', ts.first_name, ts.last_name)), \'\'),
                           tu.display_name,
                           tu.email
                       ) AS target_name,
                       tu.email AS target_email,
                       tu.role AS target_role
                FROM audit_logs al
                LEFT JOIN users au ON au.id = al.user_id
                LEFT JOIN users tu ON tu.id = al.record_id AND al.table_name = \'users\'
                LEFT JOIN students ts ON ts.user_id = tu.id
                ORDER BY al.created_at DESC, al.id DESC
                LIMIT :limit';

        $stmt = $this->db->prepare($sql);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();

        return array_map(fn(array $row): array => [
            'id' => (int) $row['id'],
            'userId' => $row['user_id'] !== null ? (int) $row['user_id'] : null,
            'actorEmail' => $row['actor_email'] ?? null,
            'actorName' => $row['actor_name'] ?? null,
            'actorRole' => $row['actor_role'] ?? null,
            'targetName' => $row['target_name'] ?? null,
            'targetEmail' => $row['target_email'] ?? null,
            'targetRole' => $row['target_role'] ?? null,
            'action' => $row['action'],
            'tableName' => $row['table_name'],
            'recordId' => (int) $row['record_id'],
            'oldValues' => $row['old_values'] !== null ? json_decode($row['old_values'], true) : null,
            'newValues' => $row['new_values'] !== null ? json_decode($row['new_values'], true) : null,
            'ipAddress' => $row['ip_address'],
            'userAgent' => $row['user_agent'],
            'createdAt' => $row['created_at'],
            'date' => substr((string) $row['created_at'], 0, 10),
        ], $stmt->fetchAll());
    }

    /* ── Users ─────────────────────────────────────────────────── */

    /**
     * List users. Only administrators can filter, staff see students.
     *
     * @return array<int,array<string,mixed>>
     */
    public function listUsers(?array $viewer, ?string $status = null, ?string $role = null): array
    {
        if ($viewer !== null && $viewer['role'] === 'student') {
            $stmt = $this->db->prepare(
                'SELECT u.id, u.public_id, u.role, u.email, u.display_name, u.status,
                        u.must_change_password,
                        s.student_id_number, s.first_name, s.last_name, s.department,
                        s.program, s.year_level, s.block,
                        s.approved_by, s.approved_at
                 FROM users u
                 LEFT JOIN students s ON s.user_id = u.id
                 WHERE u.id = :id'
            );
            $stmt->execute(['id' => $viewer['id']]);
            return array_map([$this, 'mapUser'], $stmt->fetchAll());
        }

        $where  = [];
        $params = [];

        // Officers need student records for attendance/enrollment work, but
        // do not need administrator and officer account details.
        if ($viewer !== null && $viewer['role'] === 'ssc-officer') {
            $where[] = "u.role = 'student'";
        }

        if ($status !== null) {
            $where[]          = 'u.status = :status';
            $params['status'] = $status;
        }
        if ($role !== null) {
            $where[]        = 'u.role = :role';
            $params['role'] = Auth::dbRole($role);
        }

        $sql = 'SELECT u.id, u.public_id, u.role, u.email, u.display_name, u.status,
                       u.must_change_password,
                       s.student_id_number, s.first_name, s.last_name, s.department,
                       s.program, s.year_level, s.block,
                       s.approved_by, s.approved_at,
                       o.position, o.status AS officer_status
                FROM users u
                LEFT JOIN students s ON s.user_id = u.id
                LEFT JOIN ssc_officers o ON o.user_id = u.id';

        if ($where !== []) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $sql .= ' ORDER BY u.role, u.id';

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        return array_map([$this, 'mapUser'], $stmt->fetchAll());
    }

    /**
     * Register a pending student account and profile.
     *
     * Deliberately does not start a session: an administrator must approve
     * the account before the student can sign in.
     *
     * @param array<string,mixed> $input
     */
    public function registerStudent(array $input): array
    {
        $firstName       = Validator::name($input['firstName'] ?? null, 'firstName');
        $lastName        = Validator::name($input['lastName'] ?? null, 'lastName');
        $studentIdNumber = Validator::studentIdNumber($input['studentIdNumber'] ?? null);
        $email           = Validator::email($input['email'] ?? null);
        $password        = Validator::password($input['password'] ?? null);
        $programInput    = trim((string) ($input['program'] ?? ''));
        $program         = ProgramCatalog::normalizeProgram($programInput) ?? $programInput;
        // The school is derived from the program; a submitted department
        // can never place a BSN student under Computer Studies.
        $department      = ProgramCatalog::departmentForProgram($program)
            ?? ProgramCatalog::normalizeDepartment(trim((string) ($input['department'] ?? '')))
            ?? 'Unassigned';
        $yearLevel       = trim((string) $input['yearLevel']);
        $block           = Validator::block($input['block'] ?? null);

        $this->assertMaxLength($studentIdNumber, 30, 'studentIdNumber');
        $this->assertMaxLength($firstName, 100, 'firstName');
        $this->assertMaxLength($lastName, 100, 'lastName');
        $this->assertMaxLength($email, 190, 'email');
        $this->assertMaxLength($department, 100, 'department');
        $this->assertMaxLength($program, 100, 'program');
        $this->assertMaxLength($yearLevel, 20, 'yearLevel');

        $displayName = substr(trim($firstName . ' ' . $lastName), 0, 150);

        // Generate a 6-digit OTP and an expiry in the application's campus
        // timezone: PHP's default zone is set from config['tunables']['timezone']
        // at bootstrap, and MySQL stores this wall-clock value without a suffix.
        $otp = (string) random_int(100000, 999999);
        $otpExpiresAt = (new \DateTimeImmutable('now'))
            ->modify('+10 minutes')
            ->format('Y-m-d H:i:s');

        // A pending registration may request another OTP, but active and
        // inactive accounts must remain protected from duplicate registration.
        $existingStmt = $this->db->prepare(
            'SELECT u.id, u.email, u.status, s.student_id_number
               FROM users u
               LEFT JOIN students s ON s.user_id = u.id
              WHERE u.email = :email OR s.student_id_number = :student_id'
        );
        $existingStmt->execute(['email' => $email, 'student_id' => $studentIdNumber]);
        $existingMatches = $existingStmt->fetchAll();

        foreach ($existingMatches as $existing) {
            if (strtolower((string) ($existing['status'] ?? '')) !== 'pending') {
                $emailMatches = strtolower((string) ($existing['email'] ?? '')) === strtolower($email);
                $studentIdMatches = (string) ($existing['student_id_number'] ?? '') === $studentIdNumber;
                if ($emailMatches && !$studentIdMatches) {
                    Response::fail('duplicate_email', 'This email is already registered.', 409);
                }
                if (!$emailMatches && $studentIdMatches) {
                    Response::fail('duplicate_student_id', 'This Student ID is already in use.', 409);
                }
                Response::fail('duplicate', 'That email or student ID number is already registered.', 409);
            }
        }

        $pendingUser = null;
        foreach ($existingMatches as $existing) {
            if (strtolower((string) ($existing['email'] ?? '')) === strtolower($email)) {
                $pendingUser = $existing;
                break;
            }
        }
        // Only the same email may continue a pending registration. Falling back
        // to a student-ID match would let anyone re-register against another
        // student's pending account and take over its email and profile.

        $isResendingPending = $pendingUser !== null;
        // A resend keeps the existing public id; a new account receives one from
        // insertWithRetry() so a concurrent registration cannot make this
        // request fail on the public_id unique index.
        $publicId = '';

        $this->db->beginTransaction();
        try {
            if ($isResendingPending) {
                $userId = (int) $pendingUser['id'];

                // Refresh the pending profile and credentials so a repeated
                // registration with the same email/ID remains current.
                $this->db->prepare(
                    'UPDATE users
                        SET email = :email, display_name = :display_name,
                            password_hash = :hash, status = \'pending\',
                            email_otp = :otp, otp_expires_at = :otp_expires_at
                      WHERE id = :id'
                )->execute([
                    'id' => $userId,
                    'email' => $email,
                    'display_name' => $displayName,
                    'hash' => password_hash($password, PASSWORD_DEFAULT),
                    'otp' => $otp,
                    'otp_expires_at' => $otpExpiresAt,
                ]);

                $this->db->prepare(
                    'UPDATE students SET
                        student_id_number = :idnum, first_name = :first, last_name = :last,
                        department = :department, program = :program, year_level = :year,
                        block = :block
                      WHERE user_id = :uid'
                )->execute([
                    'uid' => $userId,
                    'idnum' => $studentIdNumber,
                    'first' => $firstName,
                    'last' => $lastName,
                    'department' => $department,
                    'program' => $program,
                    'year' => $yearLevel,
                    'block' => $block,
                ]);

                $publicIdStmt = $this->db->prepare('SELECT public_id FROM users WHERE id = :id');
                $publicIdStmt->execute(['id' => $userId]);
                $publicId = (string) $publicIdStmt->fetchColumn();
            } else {
                $stmt = $this->db->prepare(
                    'INSERT INTO users
                        (public_id, role, email, display_name, password_hash, status, must_change_password, email_otp, otp_expires_at)
                     VALUES
                        (:public_id, \'student\', :email, :display_name, :hash, \'pending\', 0, :otp, :otp_expires_at)'
                );
                $passwordHash = password_hash($password, PASSWORD_DEFAULT);
                $publicId = PublicIdGenerator::insertWithRetry(
                    fn (int $offset): string => PublicIdGenerator::nextForUser($this->db, 'student', $offset),
                    function (string $candidate) use ($stmt, $email, $displayName, $passwordHash, $otp, $otpExpiresAt): string {
                        $stmt->execute([
                            'public_id'    => $candidate,
                            'email'        => $email,
                            'display_name' => $displayName,
                            'hash'         => $passwordHash,
                            'otp'          => $otp,
                            'otp_expires_at' => $otpExpiresAt,
                        ]);
                        return $candidate;
                    }
                );
                $userId = (int) $this->db->lastInsertId();

                $profile = $this->db->prepare(
                    'INSERT INTO students
                        (user_id, student_id_number, first_name, last_name, department,
                         program, year_level, block)
                     VALUES
                        (:uid, :idnum, :first, :last, :department,
                         :program, :year, :block)'
                );
                $profile->execute([
                    'uid' => $userId,
                    'idnum' => $studentIdNumber,
                    'first' => $firstName,
                    'last' => $lastName,
                    'department' => $department,
                    'program' => $program,
                    'year' => $yearLevel,
                    'block' => $block,
                ]);
            }

            $this->db->commit();
        } catch (PDOException $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            $sqlState = (string) ($e->errorInfo[0] ?? $e->getCode());
            $driverCode = (int) ($e->errorInfo[1] ?? 0);
            if ($sqlState === '23000' && $driverCode === 1062) {
                $constraintMessage = strtolower($e->getMessage());
                if (str_contains($constraintMessage, 'student_id_number') || str_contains($constraintMessage, 'uq_student_id')) {
                    Response::fail('duplicate_student_id', 'This Student ID is already in use.', 409);
                }
                Response::fail('duplicate_email', 'This email is already registered.', 409);
            }
            throw $e;
        }

        if (!Mailer::sendOtpEmail($email, $otp)) {
            // Never leave an OTP saved unless its email was delivered. For a
            // resend this preserves the account but invalidates the stale code.
            $this->db->prepare(
                'UPDATE users SET email_otp = NULL, otp_expires_at = NULL WHERE id = :id'
            )->execute(['id' => $userId]);
            if (!$isResendingPending) {
                $this->db->prepare('DELETE FROM students WHERE user_id = :id')->execute(['id' => $userId]);
                $this->db->prepare('DELETE FROM users WHERE id = :id')->execute(['id' => $userId]);
            }
            Response::fail('email_failed', 'Could not send verification email. Please try again later.', 500);
        }

        $newUser = $this->findUser($userId);
        $this->writeAudit('create', 'users', $userId, null, $newUser, null, null, null);
        return ['ok' => true, 'message' => 'OTP Sent', 'id' => $userId, 'role' => 'student', 'publicId' => $publicId];
    }

    /**
     * Verify the OTP sent to a pending student's email.
     *
     * @param string $email
     * @param string $otp
     * @return array{ok:bool, message:string}
     */
    public function verifyOtp(string $email, string $otp): array
    {
        $email = strtolower(trim($email));
        $otp = trim($otp);

        if (!preg_match('/^\d{6}$/', $otp)) {
            Response::fail('invalid_field', 'OTP must be a 6-digit code.', 422);
        }

        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare(
                'SELECT id, email_otp, otp_expires_at, status
                 FROM users
                 WHERE email = :email AND role = \'student\'
                 FOR UPDATE'
            );
            $stmt->execute(['email' => $email]);
            $user = $stmt->fetch();

            if ($user === false) {
                $this->db->rollBack();
                Response::fail('not_found', 'No pending account found for this email.', 404);
            }

            if ((string) $user['status'] !== 'pending') {
                $this->db->rollBack();
                Response::fail('invalid_transition', 'This account is not awaiting verification.', 409);
            }

            if (!hash_equals((string) ($user['email_otp'] ?? ''), $otp)) {
                $this->db->rollBack();
                Response::fail('invalid_otp', 'Invalid verification code.', 400);
            }

            // Both sides use PHP's default zone, which bootstrap aligns with the
            // configured campus timezone and the MySQL session timezone.
            $expiresAt = $user['otp_expires_at'] === null
                ? null
                : \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', (string) $user['otp_expires_at']);
            $now = new \DateTimeImmutable('now');

            if ($expiresAt === false || $expiresAt === null || $expiresAt < $now) {
                $this->db->rollBack();
                Response::fail('otp_expired', 'Verification code has expired. Please register again.', 400);
            }

            // Clearing and consuming the OTP is atomic with the row lock.
            $update = $this->db->prepare(
                'UPDATE users SET email_otp = NULL, otp_expires_at = NULL
                 WHERE id = :id AND email_otp = :otp'
            );
            $update->execute(['id' => (int) $user['id'], 'otp' => $otp]);
            if ($update->rowCount() !== 1) {
                $this->db->rollBack();
                Response::fail('invalid_otp', 'Invalid or already-used verification code.', 400);
            }

            $this->writeAudit('update', 'users', (int) $user['id'], ['email_otp' => '***'], ['email_otp' => null], null, null, null);
            $this->db->commit();
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }

        return ['ok' => true, 'message' => 'Email verified. Awaiting administrator approval.'];
    }

    /**
     * Resolve one user through the same joined shape listUsers() returns.
     *
     * @return array<string,mixed>
     */
    public function findUser(int $userId): array
    {
        $stmt = $this->db->prepare(
            'SELECT u.id, u.public_id, u.role, u.email, u.contact_number, u.last_password_change,
                    u.status, u.must_change_password,
                    s.student_id_number, s.first_name, s.last_name, s.department,
                    s.program, s.year_level, s.block,
                    s.approved_by, s.approved_at,
                    o.position, o.status AS officer_status
             FROM users u
             LEFT JOIN students s ON s.user_id = u.id
             LEFT JOIN ssc_officers o ON o.user_id = u.id
             WHERE u.id = :id'
        );
        $stmt->execute(['id' => $userId]);
        $row = $stmt->fetch();

        if ($row === false) {
            Response::fail('not_found', 'User not found.', 404);
        }
        return $this->mapUser($row);
    }

    public function updateStudentProfile(int $userId, array $input): array
    {
        $name = Validator::name($input['name'] ?? null, 'name');
        $email = Validator::email($input['email'] ?? null, 'email');
        $department = ProgramCatalog::normalizeDepartment(trim((string) ($input['department'] ?? '')))
            ?? trim((string) ($input['department'] ?? ''));
        $programInput = trim((string) ($input['program'] ?? ''));
        $program = ProgramCatalog::normalizeProgram($programInput) ?? $programInput;
        $department = ProgramCatalog::departmentForProgram($program) ?? $department;
        $yearLevel = trim((string) ($input['yearLevel'] ?? ''));
        foreach (['department' => $department, 'program' => $program, 'yearLevel' => $yearLevel] as $field => $value) {
            if ($value === '') Response::fail('invalid_field', "Field \"$field\" is required.", 422);
            $this->assertMaxLength($value, $field === 'yearLevel' ? 20 : 100, $field);
        }
        $parts = preg_split('/\\s+/', $name, 2) ?: [$name];
        $firstName = $parts[0];
        // A single-word name must not be copied into last_name, or every
        // report would print it twice.
        $lastName = $parts[1] ?? '';
        $this->assertMaxLength($firstName, 100, 'name');
        $this->assertMaxLength($lastName, 100, 'name');
        try {
            $this->db->beginTransaction();
            $check = $this->db->prepare('SELECT id FROM users WHERE id = :id AND role = \'student\' FOR UPDATE');
            $check->execute(['id' => $userId]);
            if ($check->fetchColumn() === false) {
                $this->db->rollBack();
                Response::fail('not_found', 'Student not found.', 404);
            }
            $user = $this->db->prepare('UPDATE users SET email = :email, display_name = :name WHERE id = :id');
            $user->execute(['email' => $email, 'name' => $name, 'id' => $userId]);
            $student = $this->db->prepare(
                'UPDATE students SET first_name = :first_name, last_name = :last_name,
                    department = :department, program = :program, year_level = :year_level
                 WHERE user_id = :id'
            );
            $student->execute([
                'first_name' => $firstName, 'last_name' => $lastName,
                'department' => $department, 'program' => $program,
                'year_level' => $yearLevel, 'id' => $userId,
            ]);
            $this->db->commit();
        } catch (PDOException $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            if ($error->getCode() === '23000') {
                Response::fail('duplicate', 'That email address is already in use.', 409);
            }
            throw $error;
        }
        return $this->findUser($userId);
    }

    /**
     * Update the authenticated student's own profile (email, contact_number).
     *
     * Unlike updateStudentProfile (admin-only), this allows the student to
     * update their own contact details without touching academic fields.
     */
    public function updateOwnProfile(int $userId, array $input): array
    {
        $email = Validator::email($input['email'] ?? null, 'email');

        // Contact number is optional. A missing key leaves the stored value
        // alone; an explicit null or blank string clears it. Only a real
        // value is length-checked, so omitting the field can never produce
        // a 422 response.
        $hasContactNumber = array_key_exists('contactNumber', $input);
        $contactNumber = $hasContactNumber && $input['contactNumber'] !== null
            ? trim((string) $input['contactNumber'])
            : null;
        if ($contactNumber !== null && $contactNumber !== '') {
            $this->assertMaxLength($contactNumber, 20, 'contactNumber');
        } else {
            $contactNumber = null;
        }

        $this->db->beginTransaction();
        try {
            $check = $this->db->prepare('SELECT id FROM users WHERE id = :id AND role = \'student\' FOR UPDATE');
            $check->execute(['id' => $userId]);
            if ($check->fetchColumn() === false) {
                $this->db->rollBack();
                Response::fail('not_found', 'Student not found.', 404);
            }

            // Reject credentials that already belong to another account. The
            // email column also has a unique index, but checking here lets the
            // client tell the two conflicts apart with stable error codes.
            $emailOwner = $this->db->prepare(
                'SELECT id FROM users WHERE email = :email AND id <> :id LIMIT 1'
            );
            $emailOwner->execute(['email' => $email, 'id' => $userId]);
            if ($emailOwner->fetchColumn() !== false) {
                $this->db->rollBack();
                Response::fail('email_taken', 'This email is already in use.', 409);
            }

            if ($contactNumber !== null) {
                $phoneOwner = $this->db->prepare(
                    'SELECT id FROM users WHERE contact_number = :contact_number AND id <> :id LIMIT 1'
                );
                $phoneOwner->execute(['contact_number' => $contactNumber, 'id' => $userId]);
                if ($phoneOwner->fetchColumn() !== false) {
                    $this->db->rollBack();
                    Response::fail('phone_taken', 'This contact number is already in use.', 409);
                }
            }

            $fields = ['email = :email'];
            $params = ['email' => $email, 'id' => $userId];
            if ($hasContactNumber) {
                if ($contactNumber === null) {
                    $fields[] = 'contact_number = NULL';
                } else {
                    $fields[] = 'contact_number = :contact_number';
                    $params['contact_number'] = $contactNumber;
                }
            }

            $user = $this->db->prepare('UPDATE users SET ' . implode(', ', $fields) . ' WHERE id = :id');
            $user->execute($params);

            $this->db->commit();
        } catch (PDOException $error) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            if ($error->getCode() === '23000') {
                Response::fail('email_taken', 'This email is already in use.', 409);
            }
            throw $error;
        }
        return $this->findUser($userId);
    }

    /**
     * Deactivate the authenticated student's account (set status to inactive).
     */
    public function deactivateOwnAccount(int $userId): void
    {
        $stmt = $this->db->prepare('UPDATE users SET status = \'inactive\' WHERE id = :id');
        $stmt->execute(['id' => $userId]);
    }

    /**
     * Create an approved officer account with a temporary password.
     *
     * The account is usable immediately, but requireRole() forces the
     * password change before any other authenticated endpoint is allowed.
     *
     * @param array<string,mixed> $input
     * @param array<string,mixed> $actor
     */
    public function createOfficer(array $input, array $actor): array
    {
        $firstName = Validator::name($input['firstName'] ?? null, 'firstName');
        $lastName  = Validator::name($input['lastName'] ?? null, 'lastName');
        $email     = Validator::email($input['email'] ?? null);
        $password  = Validator::password($input['password'] ?? null);
        $position  = trim((string) $input['position']);
        $this->assertMaxLength($firstName, 100, 'firstName');
        $this->assertMaxLength($lastName, 100, 'lastName');
        $this->assertMaxLength($email, 190, 'email');
        $this->assertMaxLength($position, 100, 'position');

        $displayName = substr(trim($firstName . ' ' . $lastName), 0, 150);

        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare(
                'INSERT INTO users
                    (public_id, role, email, display_name, password_hash, status, must_change_password)
                 VALUES
                    (:public_id, \'ssc_officer\', :email, :display_name, :hash, \'active\', 1)'
            );
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
            PublicIdGenerator::insertWithRetry(
                fn (int $offset): string => PublicIdGenerator::nextForUser($this->db, 'ssc_officer', $offset),
                function (string $candidate) use ($stmt, $email, $displayName, $passwordHash): string {
                    $stmt->execute([
                        'public_id'    => $candidate,
                        'email'        => $email,
                        'display_name' => $displayName,
                        'hash'         => $passwordHash,
                    ]);
                    return $candidate;
                }
            );
            $userId = (int) $this->db->lastInsertId();

            $profile = $this->db->prepare(
                'INSERT INTO ssc_officers
                    (user_id, position, approved_by, approved_at, status)
                 VALUES
                    (:uid, :position, :approved_by, NOW(), \'approved\')'
            );
            $profile->execute([
                'uid'         => $userId,
                'position'    => $position,
                'approved_by' => (int) $actor['id'],
            ]);

            $this->db->commit();
        } catch (PDOException $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            // 23000 = integrity constraint (duplicate email).
            if ($e->getCode() === '23000') {
                Response::fail('duplicate', 'That email is already registered.', 409);
            }
            throw $e;
        }

        $newOfficer = $this->findUser($userId);
        $this->writeAudit('create', 'users', $userId, null, $newOfficer, $actor['id'] ?? null, null, null);
        return $newOfficer;
    }

    /**
     * Apply one of the supported account status transitions.
     *
     * Student activation records who approved the account and when. Officer
     * rows are kept in sync so the existing officer-approval login gate does
     * not disagree with users.status.
     *
     * @param array<string,mixed> $actor
     * @return array<string,mixed>
     */
    public function updateUserStatus(int $userId, string $nextStatus, array $actor): array
    {
        $nextStatus = strtolower(trim($nextStatus));

        if (!in_array($nextStatus, ['active', 'inactive'], true)) {
            Response::fail('invalid_field', 'Field "status" must be active or inactive.', 422);
        }

        // An administrator cannot lock themselves out of the console.
        if ($nextStatus === 'inactive' && (int) ($actor['id'] ?? 0) === $userId) {
            Response::fail('invalid_transition', 'You cannot deactivate your own account.', 409);
        }

        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare(
                'SELECT id, role, status FROM users WHERE id = :id FOR UPDATE'
            );
            $stmt->execute(['id' => $userId]);
            $user = $stmt->fetch();

            if ($user === false) {
                $this->db->rollBack();
                Response::fail('not_found', 'User not found.', 404);
            }

            $currentStatus = (string) $user['status'];
            // Pending accounts can be approved or rejected; rejection keeps
            // the row for audit history and leaves the account deactivated.
            $allowed = match ($currentStatus) {
                'pending'  => ['active', 'inactive'],
                'active'   => ['inactive'],
                'inactive' => ['active'],
                default    => [],
            };

            if (!in_array($nextStatus, $allowed, true)) {
                $this->db->rollBack();
                Response::fail(
                    'invalid_transition',
                    "Cannot change status from \"$currentStatus\" to \"$nextStatus\".",
                    409
                );
            }

            $update = $this->db->prepare(
                'UPDATE users SET status = :status WHERE id = :id'
            );
            $update->execute([
                'status' => $nextStatus,
                'id'     => $userId,
            ]);

            $role = (string) $user['role'];

            if ($role === 'student' && $nextStatus === 'active') {
                $approve = $this->db->prepare(
                    'UPDATE students
                     SET approved_by = COALESCE(approved_by, :approved_by),
                         approved_at = COALESCE(approved_at, NOW())
                     WHERE user_id = :id'
                );
                $approve->execute([
                    'approved_by' => (int) $actor['id'],
                    'id'          => $userId,
                ]);
            }

            if ($role === 'ssc_officer') {
                if ($nextStatus === 'active') {
                    $officer = $this->db->prepare(
                        'UPDATE ssc_officers
                         SET status = \'approved\',
                             approved_by = COALESCE(approved_by, :approved_by),
                             approved_at = COALESCE(approved_at, NOW())
                         WHERE user_id = :id'
                    );
                    $officer->execute([
                        'approved_by' => (int) $actor['id'],
                        'id'          => $userId,
                    ]);
                } else {
                    $officer = $this->db->prepare(
                        'UPDATE ssc_officers SET status = \'deactivated\' WHERE user_id = :id'
                    );
                    $officer->execute(['id' => $userId]);
                }
            }

            $this->db->commit();
        } catch (PDOException $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }

        $updatedUser = $this->findUser($userId);
        $this->writeAudit('update', 'users', $userId, ['status' => $currentStatus], ['status' => $nextStatus], $actor['id'] ?? null, null, null);
        return $updatedUser;
    }

    /** @return array<int,array<string,mixed>> */
    public function listAttendanceCorrectionRequests(?int $studentId = null): array
    {
        $sql = 'SELECT r.id, r.student_id, r.event_id, r.requested_check_in_time, r.reason,
                       (r.proof_image IS NOT NULL AND r.proof_image <> \'\') AS has_proof,
                       r.status, r.reviewed_by, r.reviewed_at, r.review_notes,
                       r.previous_check_in_time, r.applied_at, r.created_at,
                       s.first_name, s.last_name, s.student_id_number, e.name AS event_name,
                       e.event_date, a.check_in_time AS current_check_in_time,
                       u.public_id AS student_public_id, e.public_id AS event_public_id
                FROM attendance_correction_requests r
                JOIN students s ON s.user_id = r.student_id
                JOIN users u ON u.id = s.user_id
                JOIN events e ON e.id = r.event_id
                LEFT JOIN attendance_records a ON a.event_id = r.event_id AND a.student_id = r.student_id';
        $params = [];
        if ($studentId !== null) {
            $sql .= ' WHERE r.student_id = :student_id';
            $params['student_id'] = $studentId;
        }
        $sql .= ' ORDER BY r.created_at DESC, r.id DESC';
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return array_map(static fn(array $row): array => [
            'id' => (int) $row['id'],
            'studentId' => (int) $row['student_id'],
            'studentPublicId' => $row['student_public_id'] ?? null,
            'studentName' => preg_replace('/\s+/', ' ', trim((string) ($row['first_name'] ?? '') . ' ' . ($row['last_name'] ?? ''))) === '' ? 'Unknown' : preg_replace('/\s+/', ' ', trim((string) ($row['first_name'] ?? '') . ' ' . ($row['last_name'] ?? ''))),
            'studentIdNumber' => (string) $row['student_id_number'],
            'eventId' => (int) $row['event_id'],
            'eventPublicId' => $row['event_public_id'] ?? null,
            'eventName' => (string) $row['event_name'],
            'eventDate' => (string) $row['event_date'],
            'requestedCheckInTime' => (string) $row['requested_check_in_time'],
            'currentCheckInTime' => $row['current_check_in_time'],
            'reason' => (string) $row['reason'],
            'hasProof' => (bool) ($row['has_proof'] ?? false),
            'status' => (string) $row['status'],
            'reviewedBy' => $row['reviewed_by'] !== null ? (int) $row['reviewed_by'] : null,
            'reviewedAt' => $row['reviewed_at'],
            'reviewNotes' => $row['review_notes'],
            'previousCheckInTime' => $row['previous_check_in_time'],
            'appliedAt' => $row['applied_at'],
            'date' => substr((string) $row['created_at'], 0, 10),
        ], $stmt->fetchAll());
    }

    /**
     * Load one correction request's proof image for the on-demand viewer.
     *
     * The list endpoint only returns hasProof: a 2 MB base64 photo per row
     * would dominate every response. Callers must authorise the result
     * before returning it, because a student may only read their own proof.
     *
     * @return array{studentId:int,proofImage:?string}|null
     */
    public function findAttendanceCorrectionProof(int $requestId): ?array
    {
        $stmt = $this->db->prepare(
            'SELECT student_id, proof_image
               FROM attendance_correction_requests
              WHERE id = :id
              LIMIT 1'
        );
        $stmt->execute(['id' => $requestId]);
        $row = $stmt->fetch();
        if ($row === false) {
            return null;
        }

        $image = trim((string) ($row['proof_image'] ?? ''));
        return [
            'studentId' => (int) $row['student_id'],
            'proofImage' => $image !== '' ? $image : null,
        ];
    }

    public function createAttendanceCorrectionRequest(
        int $studentId,
        int $eventId,
        string $checkInTime,
        string $reason,
        ?string $proofImage = null,
        string $timezone = 'Asia/Manila'
    ): array
    {
        $reason = trim($reason);
        $checkInTime = trim(str_replace('T', ' ', $checkInTime));
        $zone = new \DateTimeZone($timezone);
        $date = \DateTime::createFromFormat('!Y-m-d H:i', $checkInTime, $zone);
        if ($reason === '' || strlen($reason) > 3000 || !$date || $date->format('Y-m-d H:i') !== $checkInTime) {
            Response::fail('invalid_field', 'Enter a valid check-in date and time and an explanation of up to 3,000 characters.', 422);
        }
        if ($proofImage === null) {
            Response::fail('invalid_field', 'Proof of attendance is required.', 422);
        }
        $proofImage = $this->normaliseProofImage($proofImage);
        $event = $this->db->prepare('SELECT event_date, status FROM events WHERE id = :id');
        $event->execute(['id' => $eventId]);
        $eventRow = $event->fetch();
        if ($eventRow === false) Response::fail('not_found', 'Event not found.', 404);
        if ($eventRow['status'] === 'cancelled') {
            Response::fail('event_cancelled', 'Attendance corrections are unavailable for cancelled events.', 409);
        }
        if ($date->format('Y-m-d') !== (string) $eventRow['event_date']) {
            Response::fail('invalid_field', 'The requested check-in time must be on the event date.', 422);
        }
        if ($date > new \DateTime('now', $zone)) {
            Response::fail('invalid_field', 'The requested check-in time cannot be in the future.', 422);
        }
        $this->db->beginTransaction();
        try {
            $student = $this->db->prepare('SELECT user_id FROM students WHERE user_id = :id FOR UPDATE');
            $student->execute(['id' => $studentId]);
            if ($student->fetchColumn() === false) {
                $this->db->rollBack();
                Response::fail('not_found', 'Student not found.', 404);
            }
            $pending = $this->db->prepare(
                "SELECT 1 FROM attendance_correction_requests WHERE student_id = :student_id AND event_id = :event_id AND status = 'pending' LIMIT 1"
            );
            $pending->execute(['student_id' => $studentId, 'event_id' => $eventId]);
            if ($pending->fetchColumn() !== false) {
                $this->db->rollBack();
                Response::fail('request_pending', 'A correction request for this event is already pending.', 409);
            }
            $insert = $this->db->prepare(
                'INSERT INTO attendance_correction_requests
                    (student_id, event_id, requested_check_in_time, reason, proof_image)
                 VALUES (:student_id, :event_id, :check_in_time, :reason, :proof_image)'
            );
            $insert->execute([
                'student_id' => $studentId,
                'event_id' => $eventId,
                'check_in_time' => $checkInTime . ':00',
                'reason' => $reason,
                'proof_image' => $proofImage,
            ]);
            $correctionId = (int)$this->db->lastInsertId();
            $this->enqueueJob('attendance_correction_request', [
                'correction_request_id' => $correctionId,
                'student_id' => $studentId,
                'event_id' => $eventId,
            ]);
            $this->db->commit();
        } catch (PDOException $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
        return $this->listAttendanceCorrectionRequests($studentId)[0];
    }

    /**
     * Validate a proof-of-attendance data URL before it reaches MySQL.
     *
     * Only raster formats are accepted (SVG could carry script), the payload
     * must be valid base64, and the decoded image is capped at 2 MB. The
     * client resizes first, so this is a hard ceiling rather than the target.
     */
    private function normaliseProofImage(string $proofImage): string
    {
        $proofImage = trim($proofImage);
        if ($proofImage === '') {
            Response::fail('invalid_field', 'Upload a proof photo of yourself at the event.', 422);
        }
        if (!preg_match('#^data:image/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$#', $proofImage, $matches)) {
            Response::fail('invalid_field', 'Proof must be a JPEG, PNG, or WebP image.', 422);
        }
        // Reject an oversized payload before decoding it: base64_decode()
        // would otherwise allocate the full image just to discard it.
        if (strlen($matches[2]) > 2_800_000) {
            Response::fail('invalid_field', 'The proof image must be 2 MB or smaller.', 422);
        }
        $decoded = base64_decode($matches[2], true);
        if ($decoded === false || strlen($decoded) < 32) {
            Response::fail('invalid_field', 'The proof image could not be read.', 422);
        }
        $info = @getimagesizefromstring($decoded);
        if ($info === false || !in_array($info['mime'] ?? '', ['image/jpeg', 'image/png', 'image/webp'], true)) {
            Response::fail('invalid_field', 'Proof must be a readable JPEG, PNG, or WebP image.', 422);
        }
        if (strlen($decoded) > 2 * 1024 * 1024) {
            Response::fail('invalid_field', 'The proof image must be 2 MB or smaller.', 422);
        }
        return $proofImage;
    }

    public function reviewAttendanceCorrectionRequest(int $requestId, string $decision, ?string $notes, array $reviewer): array
    {
        if (!in_array($decision, ['approved', 'denied'], true)) {
            Response::fail('invalid_field', 'Decision must be approved or denied.', 422);
        }
        // The route already enforces the role, but reject a misconfigured
        // caller here rather than writing a review under a wrong identity.
        if (!isset($reviewer['id']) || !in_array((string) ($reviewer['role'] ?? ''), ['admin', 'ssc-officer'], true)) {
            Response::fail('forbidden', 'Only staff may review correction requests.', 403);
        }
        $notes = trim((string) $notes);
        if (strlen($notes) > 3000 || ($decision === 'denied' && $notes === '')) {
            Response::fail('invalid_field', 'A denial reason is required and review notes must be at most 3,000 characters.', 422);
        }
        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare(
                'SELECT id, student_id, event_id, requested_check_in_time, status
                 FROM attendance_correction_requests WHERE id = :id FOR UPDATE'
            );
            $stmt->execute(['id' => $requestId]);
            $request = $stmt->fetch();
            if ($request === false) {
                $this->db->rollBack();
                Response::fail('not_found', 'Correction request not found.', 404);
            }
            if ($request['status'] !== 'pending') {
                $this->db->rollBack();
                Response::fail('invalid_transition', 'This correction request has already been reviewed.', 409);
            }
            $attendance = $this->db->prepare(
                'SELECT id, check_in_time FROM attendance_records WHERE event_id = :event_id AND student_id = :student_id FOR UPDATE'
            );
            $attendance->execute(['event_id' => (int) $request['event_id'], 'student_id' => (int) $request['student_id']]);
            $current = $attendance->fetch();
            if ($decision === 'approved') {
                if ($current === false) {
                    $apply = $this->db->prepare(
                        "INSERT INTO attendance_records (event_id, student_id, check_in_time, verification_method)
                         VALUES (:event_id, :student_id, :check_in_time, 'manual')"
                    );
                    $apply->execute([
                        'event_id' => (int) $request['event_id'],
                        'student_id' => (int) $request['student_id'],
                        'check_in_time' => $request['requested_check_in_time'],
                    ]);
                } else {
                    $apply = $this->db->prepare(
                        "UPDATE attendance_records SET check_in_time = :check_in_time, verification_method = 'manual' WHERE id = :id"
                    );
                    $apply->execute([
                        'check_in_time' => $request['requested_check_in_time'],
                        'id' => (int) $current['id'],
                    ]);
                }
            }
            $update = $this->db->prepare(
                'UPDATE attendance_correction_requests
                 SET status = :status, reviewed_by = :reviewed_by, reviewed_at = NOW(), review_notes = :notes,
                     previous_check_in_time = :previous_time, applied_at = :applied_at
                 WHERE id = :id'
            );
            $update->execute([
                'status' => $decision,
                'reviewed_by' => (int) $reviewer['id'],
                'notes' => $notes !== '' ? $notes : null,
                'previous_time' => $current !== false ? $current['check_in_time'] : null,
                'applied_at' => $decision === 'approved' ? date('Y-m-d H:i:s') : null,
                'id' => $requestId,
            ]);
            $this->db->commit();
        } catch (\PDOException $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
        foreach ($this->listAttendanceCorrectionRequests() as $row) {
            if ($row['id'] === $requestId) return $row;
        }
        Response::fail('server_error', 'The reviewed correction request could not be loaded.', 500);
    }

    public function listKioskStations(): array
    {
        $stmt = $this->db->query(
            'SELECT id, name, device, location, last_seen_at, created_at,
                    (last_seen_at BETWEEN DATE_SUB(NOW(), INTERVAL 5 MINUTE) AND NOW()) AS is_online
             FROM kiosk_stations ORDER BY name, id'
        );
        return array_map(static fn(array $row): array => [
            'id' => (int) $row['id'],
            'name' => (string) $row['name'],
            'device' => $row['device'],
            'location' => $row['location'],
            'lastSeenAt' => $row['last_seen_at'],
            'status' => (bool) $row['is_online'] ? 'online' : 'offline',
        ], $stmt->fetchAll());
    }

    public function createKioskStation(string $name, ?string $device, ?string $location, array $admin): array
    {
        $name = trim($name);
        $device = $device !== null ? trim($device) : null;
        $location = $location !== null ? trim($location) : null;
        if ($name === '' || strlen($name) > 100 || ($device !== null && strlen($device) > 100) || ($location !== null && strlen($location) > 150)) {
            Response::fail('invalid_field', 'Station name is required; station fields are too long.', 422);
        }
        $stmt = $this->db->prepare(
            'INSERT INTO kiosk_stations (name, device, location, created_by) VALUES (:name, :device, :location, :created_by)'
        );
        $stmt->execute(['name' => $name, 'device' => $device ?: null, 'location' => $location ?: null, 'created_by' => (int) $admin['id']]);
        $id = (int) $this->db->lastInsertId();
        foreach ($this->listKioskStations() as $station) if ($station['id'] === $id) return $station;
        Response::fail('server_error', 'The new station could not be loaded.', 500);
    }

    public function heartbeatKioskStation(int $stationId): array
    {
        $stmt = $this->db->prepare('UPDATE kiosk_stations SET last_seen_at = NOW() WHERE id = :id');
        $stmt->execute(['id' => $stationId]);
        if ($stmt->rowCount() === 0) {
            $exists = $this->db->prepare('SELECT 1 FROM kiosk_stations WHERE id = :id');
            $exists->execute(['id' => $stationId]);
            if ($exists->fetchColumn() === false) Response::fail('not_found', 'Kiosk station not found.', 404);
        }
        foreach ($this->listKioskStations() as $station) if ($station['id'] === $stationId) return $station;
        Response::fail('server_error', 'Station status could not be loaded.', 500);
    }

    public function deleteKioskStation(int $stationId): void
    {
        $stmt = $this->db->prepare('DELETE FROM kiosk_stations WHERE id = :id');
        $stmt->execute(['id' => $stationId]);
        if ($stmt->rowCount() === 0) Response::fail('not_found', 'Kiosk station not found.', 404);
    }

    /* ── Events ────────────────────────────────────────────────── */

    /**
     * @return array<int,array<string,mixed>>
     */
    public function listEvents(?array $viewer = null): array
    {
        $sql = 'SELECT id, public_id, name, description, event_date, start_time, end_time,
                       checkout_open_minutes, checkout_close_minutes,
                       venue, event_type, event_category, semester, target_department,
                       attendance_type, status
                FROM events';
        $params = [];

        if (($viewer['role'] ?? '') === 'student') {
            $departmentStmt = $this->db->prepare(
                'SELECT department FROM students WHERE user_id = :user_id LIMIT 1'
            );
            $departmentStmt->execute(['user_id' => $viewer['id']]);
            $student = $departmentStmt->fetch();
            $department = $student ? (string) ($student['department'] ?? '') : '';

            $sql .= ' WHERE target_department IS NULL OR target_department = :department';
            $params['department'] = $department;
        }
        $sql .= ' ORDER BY event_date, start_time';

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return array_map([$this, 'mapEvent'], $stmt->fetchAll());
    }

    public function listAnnouncements(int $userId): array
    {
        // Announcements are notifications, not a table of their own. Event
        // announcements reference an event through related_entity_id, which
        // has no foreign key, so an event deleted by an older build can
        // leave its announcement behind. Hide those orphans instead of
        // showing a dashboard entry with no matching event.
        $stmt = $this->db->prepare(
            "SELECT n.id, n.message, n.related_entity_type, n.created_at
             FROM notifications n
             WHERE n.user_id = :user_id
               AND n.type = 'announcement'
               AND (
                   n.related_entity_type IS NULL
                   OR n.related_entity_type NOT LIKE 'announcement:event%'
                   OR EXISTS (SELECT 1 FROM events e WHERE e.id = n.related_entity_id)
               )
             ORDER BY n.created_at DESC, n.id DESC LIMIT 100"
        );
        $stmt->execute(['user_id' => $userId]);
        $announcements = [];
        foreach ($stmt->fetchAll() as $row) {
            $content = json_decode((string) $row['message'], true);
            if (!is_array($content)) continue;
            $announcements[] = [
                'id' => (int) $row['id'],
                'title' => (string) ($content['title'] ?? ''),
                'detail' => (string) ($content['detail'] ?? ''),
                'type' => str_starts_with((string) $row['related_entity_type'], 'announcement:event') ? 'event' : 'general',
                'date' => substr((string) $row['created_at'], 0, 10),
            ];
        }
        return $announcements;
    }

    /**
     * @param array<string,mixed> $input
     */
    public function createEvent(array $input, array $actor): array
    {
        $fields = $this->validateEventFields($input, 422);
        $date = $fields['date'];
        $start = $fields['start'];
        $end = $fields['end'];
        $name = $fields['name'];
        $venue = $fields['venue'];
        $type = $this->validateEventType($input['eventType'] ?? 'mandatory', 422);
        $category = $this->validateEventCategory(
            $input['eventCategory'] ?? ($type === 'mandatory' ? 'major' : 'minor'),
            422
        );
        $description = $fields['description'];
        // Read the value once: referencing $input['semester'] again in the true
        // branch reads an undefined key when the caller omitted it.
        $semesterInput = (string) ($input['semester'] ?? 'N/A');
        $semester = in_array($semesterInput, ['1st Semester', '2nd Semester', 'Summer', 'N/A'], true)
            ? $semesterInput
            : 'N/A';
        $targetDepartment = trim((string) ($input['targetDepartment'] ?? ''));
        $targetDepartment = $targetDepartment === '' ? null : $targetDepartment;
        if ($targetDepartment !== null && mb_strlen($targetDepartment) > 100) {
            Response::fail('invalid_field', 'Target department is too long.', 422);
        }

        $attendanceType = $this->validateAttendanceType(
            $input['attendanceType'] ?? 'single',
            422
        );

        // Check-out is anchored to end_time. Both offsets are configurable
        // per event; the defaults give a one-hour window on each side.
        $checkoutOpen = $input['checkoutOpenMinutes'] ?? 60;
        $checkoutClose = $input['checkoutCloseMinutes'] ?? 60;
        if (!is_numeric($checkoutOpen) || !is_numeric($checkoutClose)) {
            Response::fail('invalid_field', 'Check-out window minutes must be numbers.', 422);
        }
        $checkoutOpen = (int) $checkoutOpen;
        $checkoutClose = (int) $checkoutClose;
        if ($checkoutOpen < 0 || $checkoutOpen > 1440 || $checkoutClose < 0 || $checkoutClose > 1440) {
            Response::fail('invalid_field', 'Check-out window minutes must be between 0 and 1440.', 422);
        }

        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare(
                'INSERT INTO events
                    (public_id, name, description, event_date, start_time, end_time,
                     checkout_open_minutes, checkout_close_minutes,
                     venue, event_type, event_category, semester, target_department, attendance_type, status, created_by)
                 VALUES
                    (:public_id, :name, :description, :date, :start, :end,
                     :checkout_open, :checkout_close,
                     :venue, :type, :category, :semester, :target_department, :attendance_type, \'scheduled\', :created_by)'
            );
            PublicIdGenerator::insertWithRetry(
                fn (int $offset): string => PublicIdGenerator::nextForEvent($this->db, $offset),
                function (string $candidate) use ($stmt, $name, $description, $date, $start, $end, $checkoutOpen, $checkoutClose, $venue, $type, $category, $semester, $targetDepartment, $attendanceType, $actor): string {
                    $stmt->execute([
                        'public_id'      => $candidate,
                        'name'           => $name,
                        'description'    => $description,
                        'date'           => $date,
                        'start'          => $start,
                        'end'            => $end,
                        'checkout_open'  => $checkoutOpen,
                        'checkout_close' => $checkoutClose,
                        'venue'          => $venue,
                        'type'           => $type,
                        'category'       => $category,
                        'semester'       => $semester,
                        'target_department' => $targetDepartment,
                        'attendance_type' => $attendanceType,
                        'created_by'     => $actor['id'],
                    ]);
                    return $candidate;
                }
            );

            $id = (int) $this->db->lastInsertId();
            $this->announceEvent($id, $name, $venue, $date, $start, $targetDepartment);
            $row = $this->db->prepare(
                'SELECT id, public_id, name, description, event_date, start_time, end_time,
                        checkout_open_minutes, checkout_close_minutes,
                        venue, event_type, event_category, semester, target_department, attendance_type, status
                 FROM events WHERE id = :id'
            );
            $row->execute(['id' => $id]);
            $event = $this->mapEvent($row->fetch());
            $this->db->commit();
            $this->writeAudit('create', 'events', $id, null, $event, $actor['id'] ?? null, null, null);
            return $event;
        } catch (\Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
    }

    /**
     * Update the editable event fields. Validation rules match createEvent.
     *
     * @param array<string,mixed> $input
     * @return array<string,mixed>
     */
    public function updateEvent(int $eventId, array $input, ?array $actor = null): array
    {
        $existingStmt = $this->db->prepare(
            'SELECT id, name, description, event_date, start_time, end_time, venue,
                    event_type, event_category, semester, target_department, attendance_type
             FROM events WHERE id = :id'
        );
        $existingStmt->execute(['id' => $eventId]);
        $existing = $existingStmt->fetch();
        if ($existing === false) {
            Response::fail('not_found', 'Event not found.', 404);
        }

        // PATCH is partial: fields omitted by the caller keep their current values.
        $merged = [
            'name' => array_key_exists('name', $input) ? $input['name'] : $existing['name'],
            'date' => array_key_exists('date', $input) ? $input['date'] : $existing['event_date'],
            'startTime' => array_key_exists('startTime', $input)
                ? $input['startTime']
                : substr((string) $existing['start_time'], 0, 5),
            'endTime' => array_key_exists('endTime', $input)
                ? $input['endTime']
                : substr((string) $existing['end_time'], 0, 5),
            'venue' => array_key_exists('venue', $input) ? $input['venue'] : $existing['venue'],
            'description' => array_key_exists('description', $input)
                ? $input['description']
                : $existing['description'],
            'eventType' => array_key_exists('eventType', $input)
                ? $input['eventType']
                : $existing['event_type'],
            'eventCategory' => array_key_exists('eventCategory', $input)
                ? $input['eventCategory']
                : $existing['event_category'],
            'semester' => array_key_exists('semester', $input) ? $input['semester'] : $existing['semester'],
            'targetDepartment' => array_key_exists('targetDepartment', $input)
                ? $input['targetDepartment']
                : $existing['target_department'],
            'attendanceType' => array_key_exists('attendanceType', $input)
                ? $input['attendanceType']
                : ($existing['attendance_type'] ?? 'single'),
        ];

        $fields = $this->validateEventFields($merged, 400);
        $type = $this->validateEventType($merged['eventType'], 400);
        $category = $this->validateEventCategory($merged['eventCategory'], 400);
        $semester = in_array((string) $merged['semester'], ['1st Semester', '2nd Semester', 'Summer', 'N/A'], true)
            ? (string) $merged['semester']
            : 'N/A';
        $targetDepartment = trim((string) ($merged['targetDepartment'] ?? ''));
        $targetDepartment = $targetDepartment === '' ? null : $targetDepartment;
        if ($targetDepartment !== null && mb_strlen($targetDepartment) > 100) {
            Response::fail('invalid_field', 'Target department is too long.', 400);
        }

        $stmt = $this->db->prepare(
            'UPDATE events
             SET name = :name, description = :description, event_date = :date,
                 start_time = :start, end_time = :end, venue = :venue,
                 event_type = :type, event_category = :category,
                 semester = :semester, target_department = :target_department,
                 attendance_type = :attendance_type
             WHERE id = :id'
        );
        $stmt->execute([
            'name' => $fields['name'],
            'description' => $fields['description'],
            'date' => $fields['date'],
            'start' => $fields['start'],
            'end' => $fields['end'],
            'venue' => $fields['venue'],
            'type' => $type,
            'category' => $category,
            'semester' => $semester,
            'target_department' => $targetDepartment,
            'attendance_type' => $merged['attendanceType'] ?? 'single',
            'id' => $eventId,
        ]);

        // Announcements are a snapshot of the event details. Refresh the text
        // so the dashboard never shows a stale venue or time; when the target
        // department changes the audience changes too, so re-announce.
        $previousTarget = trim((string) ($existing['target_department'] ?? '')) === ''
            ? null
            : (string) $existing['target_department'];
        if ($targetDepartment !== $previousTarget) {
            $this->clearEventAnnouncements($eventId);
            $this->announceEvent(
                $eventId,
                $fields['name'],
                $fields['venue'],
                $fields['date'],
                $fields['start'],
                $targetDepartment
            );
        } else {
            $this->refreshEventAnnouncement(
                $eventId,
                $fields['name'],
                $fields['venue'],
                $fields['date'],
                $fields['start']
            );
        }

        $row = $this->db->prepare(
            'SELECT id, public_id, name, description, event_date, start_time, end_time,
                    checkout_open_minutes, checkout_close_minutes,
                    venue, event_type, event_category, semester, target_department,
                    attendance_type, status
             FROM events WHERE id = :id'
        );
        $row->execute(['id' => $eventId]);
        $event = $row->fetch();
        if ($event === false) {
            Response::fail('not_found', 'Event not found.', 404);
        }
        $mappedEvent = $this->mapEvent($event);
        $this->writeAudit('update', 'events', $eventId, $existing, $mappedEvent, $actor['id'] ?? null, null, null);
        return $mappedEvent;
    }

    /**
     * @param array<string,mixed> $input
     * @return array{date:string,start:string,end:string,name:string,venue:string,description:?string}
     */
    private function validateEventFields(array $input, int $invalidStatus): array
    {
        $date = (string) ($input['date'] ?? '');
        $start = (string) ($input['startTime'] ?? '');
        $end = (string) ($input['endTime'] ?? '');
        $dateValue = \DateTimeImmutable::createFromFormat('!Y-m-d', $date);
        $startValue = \DateTimeImmutable::createFromFormat('!H:i', $start);
        $endValue = \DateTimeImmutable::createFromFormat('!H:i', $end);
        if (!$dateValue || $dateValue->format('Y-m-d') !== $date) {
            Response::fail('invalid_field', 'Field "date" must be a valid YYYY-MM-DD date.', $invalidStatus);
        }
        if (!$startValue || $startValue->format('H:i') !== $start ||
            !$endValue || $endValue->format('H:i') !== $end) {
            Response::fail('invalid_field', 'Event times must be valid HH:MM values.', $invalidStatus);
        }
        $name = trim((string) ($input['name'] ?? ''));
        $venue = trim((string) ($input['venue'] ?? ''));
        $description = $input['description'] ?? null;
        if ($description !== null && !is_string($description)) {
            Response::fail('invalid_field', 'Field "description" must be text.', $invalidStatus);
        }
        if (is_string($description)) {
            $description = trim($description);
            $this->assertMaxLength($description, 10000, 'description', $invalidStatus);
        }
        if ($name === '' || $venue === '') {
            Response::fail('invalid_field', 'Event name and venue are required.', $invalidStatus);
        }
        $this->assertMaxLength($name, 150, 'name', $invalidStatus);
        $this->assertMaxLength($venue, 150, 'venue', $invalidStatus);

        return [
            'date' => $date,
            'start' => $start,
            'end' => $end,
            'name' => $name,
            'venue' => $venue,
            'description' => $description,
        ];
    }

    private function validateEventType(mixed $type, int $invalidStatus): string
    {
        if (!in_array($type, ['mandatory', 'optional'], true)) {
            Response::fail('invalid_field', 'Field "eventType" is invalid.', $invalidStatus);
        }
        return (string) $type;
    }

    private function validateEventCategory(mixed $category, int $invalidStatus): string
    {
        if (!in_array($category, ['major', 'minor'], true)) {
            Response::fail('invalid_field', 'Field "eventCategory" is invalid.', $invalidStatus);
        }
        return (string) $category;
    }

    /**
     * Delete an event. Attendance rows reference events with ON DELETE
     * RESTRICT, so an event that already has check-ins cannot be removed.
     */
    public function deleteEvent(int $eventId, ?array $actor = null): void
    {
        $existingStmt = $this->db->prepare(
            'SELECT id, name, description, event_date, start_time, end_time, venue,
                    event_type, event_category, status
             FROM events WHERE id = :id'
        );
        $existingStmt->execute(['id' => $eventId]);
        $existing = $existingStmt->fetch();
        if ($existing === false) {
            Response::fail('not_found', 'Event not found.', 404);
        }

        try {
            $this->db->beginTransaction();

            // Announcements live in `notifications` with a loose
            // related_entity_id (no foreign key), so deleting the event does
            // not remove them automatically. Delete them in the same
            // transaction or they keep appearing on the student dashboard
            // after the event is gone.
            $this->clearEventAnnouncements($eventId);

            $stmt = $this->db->prepare('DELETE FROM events WHERE id = :id');
            $stmt->execute(['id' => $eventId]);
            if ($stmt->rowCount() === 0) {
                Response::fail('not_found', 'Event not found.', 404);
            }
            $this->writeAudit('delete', 'events', $eventId, $existing, null, $actor['id'] ?? null, null, null);
            $this->db->commit();
        } catch (\Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            if ($e instanceof PDOException) {
                // getCode() only exposes the SQLSTATE (23000 for every integrity
                // failure); errorInfo[1] is the MySQL driver code that says which
                // constraint failed. 1451 = parent row still referenced by an
                // ON DELETE RESTRICT child, 1452 = child references a missing
                // parent. Either way a foreign key blocked the delete.
                $driverCode = (int) ($e->errorInfo[1] ?? 0);
                if ($driverCode === 1451 || $driverCode === 1452) {
                    Response::fail('event_in_use', 'Event has attendance records.', 409);
                }
            }
            throw $e;
        }
    }

    /* ── Attendance ────────────────────────────────────────────── */

    /**
     * @return array<int,array<string,mixed>>
     */
    public function listAttendance(?int $eventId, ?int $studentId, int $lateGraceMinutes = 15): array
    {
        $sql = 'SELECT a.id, a.event_id, a.student_id, a.check_in_time, a.check_out_time,
                       a.verification_method, a.scan_number,
                       s.student_id_number, e.event_date, e.start_time,
                       u.public_id AS student_public_id, e.public_id AS event_public_id
                FROM attendance_records a
                JOIN students s ON s.user_id = a.student_id
                JOIN users u ON u.id = s.user_id
                JOIN events e ON e.id = a.event_id
                WHERE 1 = 1';
        $params = [];

        if ($eventId !== null) {
            $sql .= ' AND a.event_id = :event_id';
            $params['event_id'] = $eventId;
        }
        if ($studentId !== null) {
            $sql .= ' AND a.student_id = :student_id';
            $params['student_id'] = $studentId;
        }
        $sql .= ' ORDER BY a.check_in_time DESC';

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return array_map(fn(array $row): array => $this->mapAttendance($row, $lateGraceMinutes), $stmt->fetchAll());
    }

    /**
     * Return staff attendance report rows, optionally filtered by event,
     * student organization and semester. All filter values are bound
     * parameters. Each row carries the student's department and program so
     * the client can aggregate an Attendance-by-Department breakdown without
     * re-joining the students table.
     *
     * @param array{eventId:?int,department:?string,program:?string,yearLevel:?string,semester:?string} $filters
     * @return array<int,array<string,mixed>>
     */
    public function listAttendanceReport(array $filters, int $lateGraceMinutes = 15): array
    {
        $sql = 'SELECT a.id, a.event_id, a.student_id, a.check_in_time, a.check_out_time,
                       a.verification_method, a.scan_number,
                       s.student_id_number, s.first_name, s.last_name,
                       s.department, s.program, s.year_level, s.block, e.event_date,
                       e.start_time, e.end_time, e.event_category, e.semester,
                       e.name AS event_name,
                       u.public_id AS student_public_id, e.public_id AS event_public_id
                FROM attendance_records a
                JOIN students s ON s.user_id = a.student_id
                JOIN users u ON u.id = s.user_id
                JOIN events e ON e.id = a.event_id
                WHERE 1 = 1';
        $params = [];

        if ($filters['eventId'] !== null) {
            $sql .= ' AND a.event_id = :event_id';
            $params['event_id'] = $filters['eventId'];
        }
        if ($filters['department'] !== null && trim($filters['department']) !== '') {
            $sql .= ' AND s.department = :department';
            $params['department'] = trim($filters['department']);
        }
        if ($filters['program'] !== null && trim($filters['program']) !== '') {
            $sql .= ' AND s.program = :program';
            $params['program'] = trim($filters['program']);
        }
        if ($filters['yearLevel'] !== null && trim($filters['yearLevel']) !== '') {
            $sql .= ' AND s.year_level = :year_level';
            $params['year_level'] = trim($filters['yearLevel']);
        }
        if ($filters['semester'] !== null && trim((string) $filters['semester']) !== '') {
            $sql .= ' AND e.semester = :semester';
            $params['semester'] = trim((string) $filters['semester']);
        }
        $sql .= ' ORDER BY a.check_in_time DESC';

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return array_map(
            fn(array $row): array => $this->mapAttendanceReport($row, $lateGraceMinutes),
            $stmt->fetchAll()
        );
    }

    /**
     * Semester/date-range attendance matrix with sanction totals.
     *
     * Every active student is returned so the matrix reads as a roster, not
     * just a list of offenders. Event columns are grouped by event_category;
     * major events expose four derived flags from the same attendance row:
     * AM In / AM Out / PM In / PM Out. A flag is true when the stored
     * timestamp falls in that half of the day, which shows morning arrivals,
     * early leavers, afternoon arrivals and full-day attendance without
     * inventing extra attendance rows.
     *
     * Total absences counts mandatory, non-cancelled events in the selected
     * range whose end timestamp has passed and which have no attendance row.
     * When $eventIds is non-empty, the event list, attendance flags and
     * absence totals are limited to those events; sanction status stays the
     * student's current standing because sanctions are not event-scoped in
     * the schema.
     *
     * @param int[] $eventIds
     * @param string|null $semester Optional semester filter ('1st Semester',
     *                            '2nd Semester', 'Summer'); null means all.
     * @param string|null $department Optional department filter; null means all.
     * @param string|null $program Optional program filter; null means all.
     * @return array{range:array{from:?string,to:?string,eventIds:int[],eventId:?int,semester:?string,department:?string,program:?string},events:array<int,array<string,mixed>>,students:array<int,array<string,mixed>>}
     */
    public function listSanctionMatrix(?string $from = null, ?string $to = null, array $eventIds = [], ?string $semester = null, ?string $department = null, ?string $program = null): array
    {
        $from = $from !== null && trim($from) !== '' ? trim($from) : null;
        $to = $to !== null && trim($to) !== '' ? trim($to) : null;
        $semester = $semester !== null && trim($semester) !== '' ? trim($semester) : null;
        $department = $department !== null && trim($department) !== '' ? trim($department) : null;
        $program = $program !== null && trim($program) !== '' ? trim($program) : null;
        $eventIds = array_values(array_unique(array_filter(
            array_map(static fn($id): int => (int) $id, $eventIds),
            static fn(int $id): bool => $id > 0
        )));

        $eventSql = <<<'SQL'
            SELECT id, public_id, name, event_date, start_time, end_time,
                   event_type, event_category, status, target_department,
                   CASE
                     WHEN end_time <= start_time
                       THEN DATE_ADD(TIMESTAMP(event_date, end_time), INTERVAL 1 DAY)
                     ELSE TIMESTAMP(event_date, end_time)
                   END < NOW() AS has_ended
              FROM events
             WHERE status <> 'cancelled'
            SQL;
        $eventParams = [];
        if ($from !== null) {
            $eventSql .= ' AND event_date >= :from';
            $eventParams['from'] = $from;
        }
        if ($to !== null) {
            $eventSql .= ' AND event_date <= :to';
            $eventParams['to'] = $to;
        }
        if ($semester !== null) {
            $eventSql .= ' AND semester = :semester';
            $eventParams['semester'] = $semester;
        }
        if ($eventIds !== []) {
            $placeholders = [];
            foreach ($eventIds as $index => $id) {
                $placeholder = ':event_id_' . $index;
                $placeholders[] = $placeholder;
                $eventParams['event_id_' . $index] = $id;
            }
            $eventSql .= ' AND id IN (' . implode(', ', $placeholders) . ')';
        }
        $eventSql .= ' ORDER BY event_date, start_time, id';

        $eventStmt = $this->db->prepare($eventSql);
        $eventStmt->execute($eventParams);

        $events = [];
        $endedMandatory = [];
        foreach ($eventStmt->fetchAll() as $row) {
            $rowEventId = (int) $row['id'];
            $mandatory = (string) $row['event_type'] === 'mandatory';
            if ($mandatory && (int) $row['has_ended'] === 1) {
                $endedMandatory[] = [
                    'id' => $rowEventId,
                    'target' => $row['target_department'] ?? null,
                ];
            }
            $events[] = [
                'id' => $rowEventId,
                'publicId' => $row['public_id'] ?? null,
                'name' => $row['name'],
                'date' => $row['event_date'],
                'startTime' => substr((string) $row['start_time'], 0, 5),
                'endTime' => substr((string) $row['end_time'], 0, 5),
                'category' => $this->eventCategoryFromRow($row),
                'mandatory' => $mandatory,
                'semester' => $row['semester'] ?? null,
                'status' => $row['status'],
                'hasEnded' => (int) $row['has_ended'] === 1,
            ];
        }

        $attendanceSql = <<<'SQL'
            SELECT a.student_id, a.event_id, a.check_in_time, a.check_out_time
              FROM attendance_records a
              JOIN events e ON e.id = a.event_id
             WHERE e.status <> 'cancelled'
            SQL;
        $attendanceParams = [];
        if ($from !== null) {
            $attendanceSql .= ' AND e.event_date >= :from';
            $attendanceParams['from'] = $from;
        }
        if ($to !== null) {
            $attendanceSql .= ' AND e.event_date <= :to';
            $attendanceParams['to'] = $to;
        }
        if ($semester !== null) {
            $attendanceSql .= ' AND e.semester = :semester';
            $attendanceParams['semester'] = $semester;
        }
        if ($eventIds !== []) {
            $placeholders = [];
            foreach ($eventIds as $index => $id) {
                $placeholder = ':attendance_event_id_' . $index;
                $placeholders[] = $placeholder;
                $attendanceParams['attendance_event_id_' . $index] = $id;
            }
            $attendanceSql .= ' AND e.id IN (' . implode(', ', $placeholders) . ')';
        }
        $attendanceStmt = $this->db->prepare($attendanceSql);
        $attendanceStmt->execute($attendanceParams);

        $attendanceByStudent = [];
        foreach ($attendanceStmt->fetchAll() as $row) {
            $studentId = (int) $row['student_id'];
            $rowEventId = (int) $row['event_id'];
            $checkIn = (string) $row['check_in_time'];
            $checkOut = $row['check_out_time'] !== null ? (string) $row['check_out_time'] : null;
            $inHour = (int) substr($checkIn, 11, 2);
            $outHour = $checkOut !== null ? (int) substr($checkOut, 11, 2) : null;
            $entry = [
                'attended' => true,
                'amIn' => $inHour < 12,
                'amOut' => $outHour !== null && $outHour < 12,
                'pmIn' => $inHour >= 12,
                'pmOut' => $outHour !== null && $outHour >= 12,
                'checkIn' => substr($checkIn, 11, 5),
                'checkOut' => $checkOut !== null ? substr($checkOut, 11, 5) : null,
            ];

            // four_point events store one row per scan pair (AM and PM).
            // Merge every row for the student/event so the matrix shows all
            // four flags instead of letting the last row overwrite the first.
            $previous = $attendanceByStudent[$studentId][$rowEventId] ?? null;
            if ($previous !== null) {
                $entry['amIn'] = $previous['amIn'] || $entry['amIn'];
                $entry['amOut'] = $previous['amOut'] || $entry['amOut'];
                $entry['pmIn'] = $previous['pmIn'] || $entry['pmIn'];
                $entry['pmOut'] = $previous['pmOut'] || $entry['pmOut'];
                $entry['checkIn'] = min($previous['checkIn'], $entry['checkIn']);
                if ($previous['checkOut'] === null) {
                    // keep this row's check-out
                } elseif ($entry['checkOut'] === null) {
                    $entry['checkOut'] = $previous['checkOut'];
                } else {
                    $entry['checkOut'] = max($previous['checkOut'], $entry['checkOut']);
                }
            }

            $attendanceByStudent[$studentId][$rowEventId] = $entry;
        }

        $studentSql = <<<'SQL'
            SELECT s.user_id AS student_id, u.public_id AS student_public_id,
                    s.student_id_number,
                    TRIM(CONCAT(s.first_name, ' ', s.last_name)) AS student_name,
                    s.department, s.program, s.year_level, s.block
               FROM students s
               JOIN users u ON u.id = s.user_id
              WHERE u.role = 'student' AND u.status = 'active'
            SQL;
        $studentParams = [];
        if ($department !== null) {
            $studentSql .= ' AND s.department = :department';
            $studentParams['department'] = $department;
        }
        if ($program !== null) {
            $studentSql .= ' AND s.program = :program';
            $studentParams['program'] = $program;
        }
        $studentSql .= ' ORDER BY s.last_name, s.first_name';

        $studentStmt = $this->db->prepare($studentSql);
        $studentStmt->execute($studentParams);
        $students = $studentStmt->fetchAll();

        $rows = [];
        foreach ($students as $student) {
            $studentId = (int) $student['student_id'];
            $attendance = $attendanceByStudent[$studentId] ?? [];
            $studentProgram = $student['program'] ?? null;
            $studentDepartment = $student['department'] ?? null;
            if ($studentProgram !== null && trim((string) $studentProgram) !== '') {
                $studentProgram = ProgramCatalog::normalizeProgram((string) $studentProgram)
                    ?? trim((string) $studentProgram);
                $studentDepartment = ProgramCatalog::departmentForProgram($studentProgram)
                    ?? ProgramCatalog::normalizeDepartment((string) $studentDepartment)
                    ?? 'Unassigned';
            } elseif ($studentDepartment !== null) {
                $studentDepartment = ProgramCatalog::normalizeDepartment((string) $studentDepartment)
                    ?? trim((string) $studentDepartment);
            }

            $absences = 0;
            foreach ($endedMandatory as $endedEvent) {
                if (isset($attendance[$endedEvent['id']])) {
                    continue;
                }
                // A student cannot be absent from an event their department was
                // never targeted for; only untargeted events count for everyone.
                if (!$this->eventTargetsDepartment($endedEvent['target'], (string) ($studentDepartment ?? ''))) {
                    continue;
                }
                $absences++;
            }

            $rows[] = [
                'studentId' => $studentId,
                'studentPublicId' => $student['student_public_id'] ?? null,
                'studentIdNumber' => $student['student_id_number'],
                'studentName' => $student['student_name'],
                'department' => $studentDepartment ?? 'Unassigned',
                'program' => $studentProgram ?? 'Unassigned',
                'yearLevel' => $student['year_level'] ?? null,
                'block' => $student['block'] ?? null,
                'totalAbsences' => $absences,
                'forSanction' => $absences > 3,
                'attendance' => $attendance === [] ? new \stdClass() : $attendance,
            ];
        }

        usort($rows, static function (array $a, array $b): int {
            if ($a['totalAbsences'] !== $b['totalAbsences']) {
                return $b['totalAbsences'] <=> $a['totalAbsences'];
            }
            return strcasecmp((string) $a['studentName'], (string) $b['studentName']);
        });

        return [
            'range' => [
                'from' => $from,
                'to' => $to,
                'eventIds' => $eventIds,
                'eventId' => count($eventIds) === 1 ? $eventIds[0] : null,
                'semester' => $semester,
                'department' => $department,
                'program' => $program,
            ],
            'events' => $events,
            'students' => $rows,
        ];
    }

    /**
     * Read the report category from a row, falling back to the older
     * mandatory/optional meaning when event_category has not been selected.
     *
     * @param array<string,mixed> $row
     */
    private function eventCategoryFromRow(array $row): string
    {
        $category = (string) ($row['event_category'] ?? '');
        if ($category === 'major' || $category === 'minor') {
            return $category;
        }
        return (string) ($row['event_type'] ?? '') === 'mandatory' ? 'major' : 'minor';
    }

    /**
     * Record a check-in. The UNIQUE(event_id, student_id) constraint is
     * the real duplicate guard — a race between two kiosks is rejected by
     * MySQL, not by a prior SELECT.
     *
     * @param array<string,mixed> $input
     */
    public function checkIn(
        array $input,
        int $openMinutesBefore = 30,
        int $closeMinutesAfter = 360,
        string $timezone = 'Asia/Manila',
        int $lateGraceMinutes = 15
    ): array
    {
        $eventId = (int) $input['eventId'];
        $studentId = (int) $input['studentId'];
        $this->assertCheckInWindow($eventId, $openMinutesBefore, $closeMinutesAfter, $timezone);

        $activeStudent = $this->db->prepare(
            "SELECT 1 FROM users u JOIN students s ON s.user_id = u.id
             WHERE u.id = :id AND u.role = 'student' AND u.status = 'active' LIMIT 1"
        );
        $activeStudent->execute(['id' => $studentId]);
        if ($activeStudent->fetchColumn() === false) {
            Response::fail('student_not_active', 'This student account is not active.', 403);
        }

        try {
            $stmt = $this->db->prepare(
                'INSERT INTO attendance_records (event_id, student_id, verification_method, scan_number)
                 VALUES (:event_id, :student_id, :method, 1)'
            );
            $stmt->execute([
                'event_id'   => $input['eventId'],
                'student_id' => $input['studentId'],
                'method'     => in_array($input['verificationMethod'] ?? '', ['manual', 'qr'], true) ? $input['verificationMethod'] : 'manual',
            ]);
        } catch (PDOException $e) {
            // getCode() only exposes the SQLSTATE (23000 for both duplicate
            // rows and foreign-key failures). The MySQL driver code in
            // errorInfo distinguishes them: 1062 duplicate, 1452 foreign key.
            $driverCode    = (int) ($e->errorInfo[1] ?? 0);
            $driverMessage = (string) ($e->errorInfo[2] ?? $e->getMessage());

            if ($driverCode === 1062) {
                Response::fail('duplicate_checkin', 'This student is already checked in for that event.', 409);
            }
            if ($driverCode === 1452) {
                if (str_contains($driverMessage, 'fk_att_student')) {
                    Response::fail('student_not_found', 'No student is registered under that ID.', 404);
                }
                if (str_contains($driverMessage, 'fk_att_event')) {
                    Response::fail('event_not_found', 'No event is registered under that ID.', 404);
                }
            }
            throw $e;
        }

        $id = (int) $this->db->lastInsertId();
        $row = $this->db->prepare(
            'SELECT a.id, a.event_id, a.student_id, a.check_in_time, a.check_out_time,
                    a.verification_method, a.scan_number, e.event_date, e.start_time
             FROM attendance_records a JOIN events e ON e.id = a.event_id WHERE a.id = :id'
        );
        $row->execute(['id' => $id]);
        return $this->mapAttendance($row->fetch(), $lateGraceMinutes);
    }

    /**
     * Record a check-out against an existing check-in row.
     *
     * The attendance table keeps one row per student/event, so checking out
     * updates check_out_time instead of inserting a second row. The UPDATE is
     * guarded by `check_out_time IS NULL`; a race between two kiosks is
     * resolved by MySQL, not by a prior SELECT.
     *
     * @param array<string,mixed> $input
     */
    public function checkOut(
        array $input,
        int $openMinutesBeforeEnd = 60,
        int $closeMinutesAfterEnd = 60,
        string $timezone = 'Asia/Manila',
        int $lateGraceMinutes = 15
    ): array {
        $eventId = (int) $input['eventId'];
        $studentId = (int) $input['studentId'];
        $this->assertCheckoutWindow($eventId, $openMinutesBeforeEnd, $closeMinutesAfterEnd, $timezone);

        $row = $this->findAttendanceRow($eventId, $studentId);
        if ($row === false) {
            Response::fail(
                'not_checked_in',
                'This student has not checked in for that event.',
                409
            );
        }
        if ($row['check_out_time'] !== null) {
            Response::fail(
                'duplicate_checkout',
                'This student is already checked out for that event.',
                409
            );
        }

        $update = $this->db->prepare(
            'UPDATE attendance_records
             SET check_out_time = CURRENT_TIMESTAMP
             WHERE id = :id AND check_out_time IS NULL'
        );
        $update->execute(['id' => (int) $row['id']]);
        if ($update->rowCount() !== 1) {
            Response::fail(
                'duplicate_checkout',
                'This student is already checked out for that event.',
                409
            );
        }

        $updated = $this->findAttendanceRow($eventId, $studentId);
        return $this->mapAttendance($updated, $lateGraceMinutes);
    }

    /**
     * @return array<string,mixed>|false
     */
    private function findAttendanceRow(int $eventId, int $studentId): array|false
    {
        $stmt = $this->db->prepare(
            'SELECT a.id, a.event_id, a.student_id, a.check_in_time, a.check_out_time,
                    a.verification_method, a.scan_number, e.event_date, e.start_time
             FROM attendance_records a
             JOIN events e ON e.id = a.event_id
             WHERE a.event_id = :event_id AND a.student_id = :student_id
             ORDER BY a.scan_number DESC, a.id DESC
             LIMIT 1'
        );
        $stmt->execute(['event_id' => $eventId, 'student_id' => $studentId]);
        return $stmt->fetch();
    }

    /**
     * Issue the signed, event-scoped QR token for a student.
     *
     * Tokens are stateless HMACs, so issuing one writes nothing to MySQL.
     * The event must still be scheduled and not already finished; the kiosk
     * separately enforces the check-in window.
     *
     * @return array<string,mixed>
     */
    public function issueEventQrToken(
        int $studentId,
        int $eventId,
        string $secret,
        string $timezone = 'Asia/Manila'
    ): array {
        if (strlen($secret) < 32) {
            throw new \RuntimeException('The QR signing secret is not configured.');
        }

        $stmt = $this->db->prepare(
            'SELECT id, public_id, name, event_date, start_time, end_time, status,
                    target_department,
                    CASE WHEN end_time <= start_time
                         THEN DATE_ADD(TIMESTAMP(event_date, end_time), INTERVAL 1 DAY)
                         ELSE TIMESTAMP(event_date, end_time)
                    END AS ends_at
             FROM events WHERE id = :id LIMIT 1'
        );
        $stmt->execute(['id' => $eventId]);
        $event = $stmt->fetch();
        if ($event === false) {
            Response::fail('event_not_found', 'No event is registered under that ID.', 404);
        }
        if ((string) $event['status'] !== 'scheduled') {
            Response::fail('event_unavailable', 'This event is not accepting check-in QR codes.', 409);
        }

        $zone  = new \DateTimeZone($timezone);
        $endsAt = \DateTimeImmutable::createFromFormat('Y-m-d H:i:s', (string) $event['ends_at'], $zone);
        if ($endsAt === false) {
            // TIMESTAMP() can be ambiguous during a DST transition. Fall back
            // to the wall-clock date and apply the same overnight correction.
            $endsAt = new \DateTimeImmutable(
                (string) $event['event_date'] . ' ' . (string) $event['end_time'],
                $zone
            );
            $startsAt = new \DateTimeImmutable(
                (string) $event['event_date'] . ' ' . (string) $event['start_time'],
                $zone
            );
            if ($endsAt <= $startsAt) {
                $endsAt = $endsAt->modify('+1 day');
            }
        }
        if ($endsAt <= new \DateTimeImmutable('now', $zone)) {
            Response::fail('event_ended', 'This event has already ended.', 409);
        }

        // The student must be enrolled in the event's target department when
        // the event is department-restricted. A token for an event the
        // student is not enrolled in is never valid, even before time check.
        if (!empty($event['target_department'])) {
            $departmentStmt = $this->db->prepare(
                'SELECT department FROM students WHERE user_id = :student_id LIMIT 1'
            );
            $departmentStmt->execute(['student_id' => $studentId]);
            $student = $departmentStmt->fetch();
            $studentDepartment = $student ? trim((string) ($student['department'] ?? '')) : '';

            if ($studentDepartment !== '' && $studentDepartment !== $event['target_department']) {
                Response::fail(
                    'not_eligible',
                    'This event is not open to your department.',
                    403
                );
            }
        }

        return [
            'eventId'       => (int) $event['id'],
            'eventPublicId' => $event['public_id'] ?? null,
            'eventName'     => (string) $event['name'],
            'eventDate'     => (string) $event['event_date'],
            'startTime'     => substr((string) $event['start_time'], 0, 5),
            'endTime'       => substr((string) $event['end_time'], 0, 5),
            'qrToken'       => QrToken::generateEventToken($studentId, $eventId, $secret),
        ];
    }

    /**
     * Match a live kiosk QR scan to an active student, then record a
     * check-in or check-out. The token must be signed for the same event
     * the kiosk is currently operating; a valid token for another event is
     * rejected before any attendance row is written.
     */
    public function checkInByQr(
        int $eventId,
        string $qrToken,
        string $qrSecret,
        string $action = 'in',
        int $openMinutesBefore = 30,
        int $closeMinutesAfter = 360,
        string $timezone = 'Asia/Manila',
        int $lateGraceMinutes = 15,
        int $checkoutOpenMinutesBeforeEnd = 60,
        int $checkoutCloseMinutesAfterEnd = 60
    ): array {
        $action = strtolower(trim($action));
        if (!in_array($action, ['in', 'out'], true)) {
            Response::fail('invalid_field', 'Field "action" must be "in" or "out".', 422);
        }

        if (strlen($qrSecret) < 32) {
            throw new \RuntimeException('The QR signing secret is not configured.');
        }

        // Reject malformed tokens before they reach the database so a forged
        // or padded code can never touch the student lookup.
        if (!QrToken::isValid($qrToken)) {
            Response::fail('invalid_qr', 'That QR code is not a valid check-in code.', 422);
        }

        $scanned = QrToken::parseEventToken($qrToken, $qrSecret);
        if ($scanned === null) {
            // A well-shaped token with a bad signature is still just an
            // invalid QR code; do not reveal which part failed.
            Response::fail('invalid_qr', 'That QR code is not a valid check-in code.', 422);
        }

        // The signature covers the event id, so a token issued for another
        // event cannot be replayed here even by a currently active student.
        // Checked before the time window on purpose: scanning yesterday's code
        // must answer "wrong event", not "check-in closed", which would tell the
        // kiosk operator that this event is currently open.
        if ($scanned['eventId'] !== $eventId) {
            Response::fail('invalid_qr_event', 'Invalid QR code for this event.', 400);
        }

        if ($action === 'out') {
            $this->assertCheckoutWindow(
                $eventId,
                $checkoutOpenMinutesBeforeEnd,
                $checkoutCloseMinutesAfterEnd,
                $timezone
            );
        } else {
            $this->assertCheckInWindow($eventId, $openMinutesBefore, $closeMinutesAfter, $timezone);
        }

        $stmt = $this->db->prepare(
            'SELECT u.id, u.role, u.status, s.first_name, s.last_name, s.department
             FROM users u
             JOIN students s ON s.user_id = u.id
             WHERE u.id = :student_id
               AND u.role = \'student\'
               AND u.status = \'active\'
             LIMIT 1'
        );
        $stmt->execute(['student_id' => $scanned['studentId']]);
        $row = $stmt->fetch();

        if ($row === false) {
            // Do not distinguish "no such student" from "deactivated account":
            // both are simply not a usable check-in.
            Response::fail('invalid_qr', 'That QR code does not belong to an active student account.', 422);
        }

        $studentId   = (int) $row['id'];
        $studentName = trim(($row['first_name'] ?? '') . ' ' . ($row['last_name'] ?? ''));

        // Load the event's attendance_type and target department so we can
        // enforce both the scan policy and department eligibility.
        $eventRow = $this->db->prepare(
            'SELECT attendance_type, target_department FROM events WHERE id = :id LIMIT 1'
        );
        $eventRow->execute(['id' => $eventId]);
        $event = $eventRow->fetch();
        $attendanceType = $event !== false && isset($event['attendance_type'])
            ? strtolower((string) $event['attendance_type'])
            : 'single';

        // A valid token for a department-restricted event is still refused when
        // the student is not enrolled in that department. Checked before any
        // attendance row is written so an ineligible scan leaves no trace.
        $targetDepartment = $event !== false ? ($event['target_department'] ?? null) : null;
        if (!empty($targetDepartment) && (string) ($row['department'] ?? '') !== (string) $targetDepartment) {
            Response::fail('not_eligible', 'This event is not open to your department.', 403);
        }

        if ($action === 'out') {
            // --- Check-out policy by attendance_type ---
            if ($attendanceType === 'single') {
                Response::fail(
                    'invalid_action',
                    'This event does not use check-outs. Scan for attendance only.',
                    409
                );
            }

            $existing = $this->findAttendanceRow($eventId, $studentId);

            if ($attendanceType === 'in_out') {
                // in_out: must be checked in but not yet checked out.
                if ($existing === false) {
                    Response::fail(
                        'not_checked_in',
                        'This student has not checked in for that event.',
                        409
                    );
                }
                if ($existing['check_out_time'] !== null) {
                    Response::fail(
                        'duplicate_checkout',
                        'This student is already checked out for that event.',
                        409
                    );
                }
                $attendance = $this->checkOut(
                    ['eventId' => $eventId, 'studentId' => $studentId],
                    $checkoutOpenMinutesBeforeEnd,
                    $checkoutCloseMinutesAfterEnd,
                    $timezone,
                    $lateGraceMinutes
                );
                $attendance['message'] = "Goodbye, {$studentName}! Time out recorded.";
            } else {
                // four_point: a check-out is scan 2 (AM out) or scan 4 (PM out).
                // scan_number stores the number of completed scans on the
                // latest row, so check-out is valid only after an odd scan.
                if ($existing === false) {
                    Response::fail(
                        'not_checked_in',
                        'This student has not checked in for that event.',
                        409
                    );
                }
                $scanNumber = (int) ($existing['scan_number'] ?? 0);
                if ($scanNumber === 0) {
                    $scanNumber = 1; // legacy row -> AM time in already recorded.
                }
                if ($scanNumber % 2 === 0) {
                    Response::fail(
                        'duplicate_checkout',
                        'This student is already checked out for this scan point.',
                        409
                    );
                }
                $nextScan = $scanNumber + 1;
                if ($existing['check_out_time'] !== null) {
                    Response::fail(
                        'duplicate_checkout',
                        'This student is already checked out for this scan point.',
                        409
                    );
                }
                $attendance = $this->checkOut(
                    ['eventId' => $eventId, 'studentId' => $studentId],
                    $checkoutOpenMinutesBeforeEnd,
                    $checkoutCloseMinutesAfterEnd,
                    $timezone,
                    $lateGraceMinutes
                );
                $this->db->prepare(
                    'UPDATE attendance_records SET scan_number = :n WHERE id = :id'
                )->execute(['n' => $nextScan, 'id' => (int) $attendance['id']]);
                $attendance['scanNumber'] = $nextScan;
                $label = $nextScan === 2 ? 'AM time out' : 'PM time out';
                $attendance['message'] = "Goodbye, {$studentName}! {$label} recorded.";
            }
        } else {
            // --- Check-in policy by attendance_type ---
            if ($attendanceType === 'single') {
                // First scan = present; reject any further scans.
                $existing = $this->findAttendanceRow($eventId, $studentId);
                if ($existing !== false) {
                    Response::fail(
                        'duplicate_checkin',
                        'This student is already checked in for that event.',
                        409
                    );
                }
                $attendance = $this->checkIn(
                    ['eventId' => $eventId, 'studentId' => $studentId, 'verificationMethod' => 'qr'],
                    $openMinutesBefore,
                    $closeMinutesAfter,
                    $timezone,
                    $lateGraceMinutes
                );
                $attendance['message'] = "Welcome, {$studentName}! Attendance recorded.";
            } elseif ($attendanceType === 'in_out') {
                // in_out: first scan = time in; second scan should send action='out'.
                $existing = $this->findAttendanceRow($eventId, $studentId);
                if ($existing !== false && $existing['check_out_time'] === null) {
                    Response::fail(
                        'duplicate_checkin',
                        'This student is already checked in. Send action=out to check out.',
                        409
                    );
                }
                if ($existing !== false && $existing['check_out_time'] !== null) {
                    Response::fail(
                        'duplicate_checkin',
                        'This student is already checked out for that event.',
                        409
                    );
                }
                $attendance = $this->checkIn(
                    ['eventId' => $eventId, 'studentId' => $studentId, 'verificationMethod' => 'qr'],
                    $openMinutesBefore,
                    $closeMinutesAfter,
                    $timezone,
                    $lateGraceMinutes
                );
                $attendance['message'] = "Welcome, {$studentName}! Time in recorded.";
            } else {
                // four_point: cycle AM In(1) -> AM Out(2) -> PM In(3) -> PM Out(4).
                $existing = $this->findAttendanceRow($eventId, $studentId);
                if ($existing === false) {
                    // Scan 1: AM In.
                    $attendance = $this->checkIn(
                        ['eventId' => $eventId, 'studentId' => $studentId, 'verificationMethod' => 'qr'],
                        $openMinutesBefore,
                        $closeMinutesAfter,
                        $timezone,
                        $lateGraceMinutes
                    );
                    $attendance['message'] = "Welcome, {$studentName}! AM time in recorded.";
                    $this->db->prepare(
                        'UPDATE attendance_records SET scan_number = 1 WHERE id = :id'
                    )->execute(['id' => (int) $attendance['id']]);
                    $attendance['scanNumber'] = 1;
                } else {
                    $scanNumber = (int) ($existing['scan_number'] ?? 0);
                    if ($scanNumber === 0) {
                        $scanNumber = 1; // legacy row -> treat as scan 1 done.
                    }
                    $nextScan = $scanNumber + 1;

                    if ($nextScan > 4) {
                        Response::fail(
                            'duplicate_checkin',
                            'This student has completed all 4 scans for this event.',
                            409
                        );
                    }

                    if ($nextScan === 3) {
                        // PM In: must be checked out from AM first.
                        if ($existing['check_out_time'] === null) {
                            Response::fail(
                                'invalid_action',
                                'This student is currently checked in. Check out (scan 2) before scanning in again.',
                                409
                            );
                        }
                        $attendance = $this->checkIn(
                            ['eventId' => $eventId, 'studentId' => $studentId, 'verificationMethod' => 'qr'],
                            $openMinutesBefore,
                            $closeMinutesAfter,
                            $timezone,
                            $lateGraceMinutes
                        );
                        $attendance['message'] = "Welcome, {$studentName}! PM time in recorded.";
                    } else {
                        // Should not reach here for action='in' — scans 2 and 4 are check-outs.
                        Response::fail(
                            'invalid_action',
                            'Unexpected scan state. Expected check-out, not check-in.',
                            409
                        );
                    }

                    $this->db->prepare(
                        'UPDATE attendance_records SET scan_number = :n WHERE id = :id'
                    )->execute(['n' => $nextScan, 'id' => (int) $attendance['id']]);
                    $attendance['scanNumber'] = $nextScan;
                }
            }
        }

        $attendance['action']           = $action;
        $attendance['studentName']      = $studentName;
        $attendance['verificationMethod'] = 'qr';
        return $attendance;
    }

    private function assertCheckInWindow(
        int $eventId,
        int $openMinutesBefore,
        int $closeMinutesAfter,
        string $timezone
    ): void {
        $stmt = $this->db->prepare(
            'SELECT event_date, start_time, status FROM events WHERE id = :id LIMIT 1'
        );
        $stmt->execute(['id' => $eventId]);
        $event = $stmt->fetch();
        if ($event === false) {
            Response::fail('event_not_found', 'No event is registered under that ID.', 404);
        }
        if ($event['status'] !== 'scheduled') {
            Response::fail('event_unavailable', 'This event is not accepting check-ins.', 409);
        }
        $zone = new \DateTimeZone($timezone);
        $start = new \DateTimeImmutable(
            (string) $event['event_date'] . ' ' . (string) $event['start_time'],
            $zone
        );
        $opensAt = $start->modify(sprintf('-%d minutes', max(0, $openMinutesBefore)));
        $closesAt = $start->modify(sprintf('+%d minutes', max(0, $closeMinutesAfter)));
        $now = new \DateTimeImmutable('now', $zone);
        if ($now < $opensAt || $now > $closesAt) {
            Response::fail('checkin_closed', 'This event is outside its check-in window.', 409);
        }
    }

    /**
     * The check-out window is anchored to end_time and stored per event.
     * A value of 60/60 means one hour before through one hour after the end.
     */
    private function assertCheckoutWindow(
        int $eventId,
        int $defaultOpenMinutesBeforeEnd,
        int $defaultCloseMinutesAfterEnd,
        string $timezone
    ): void {
        $stmt = $this->db->prepare(
            'SELECT event_date, start_time, end_time, status,
                    checkout_open_minutes, checkout_close_minutes
             FROM events WHERE id = :id LIMIT 1'
        );
        $stmt->execute(['id' => $eventId]);
        $event = $stmt->fetch();
        if ($event === false) {
            Response::fail('event_not_found', 'No event is registered under that ID.', 404);
        }
        if ($event['status'] !== 'scheduled') {
            Response::fail('event_unavailable', 'This event is not accepting check-outs.', 409);
        }
        $openMinutes = $event['checkout_open_minutes'] !== null
            ? (int) $event['checkout_open_minutes']
            : $defaultOpenMinutesBeforeEnd;
        $closeMinutes = $event['checkout_close_minutes'] !== null
            ? (int) $event['checkout_close_minutes']
            : $defaultCloseMinutesAfterEnd;
        $zone = new \DateTimeZone($timezone);
        $date = (string) $event['event_date'];
        $start = new \DateTimeImmutable($date . ' ' . (string) $event['start_time'], $zone);
        $end = new \DateTimeImmutable($date . ' ' . (string) $event['end_time'], $zone);
        // TIME columns carry no date. An end_time earlier than start_time is
        // an event that runs past midnight, so its end belongs to the next day.
        if ($end <= $start) {
            $end = $end->modify('+1 day');
        }
        $opensAt = $end->modify(sprintf('-%d minutes', max(0, $openMinutes)));
        $closesAt = $end->modify(sprintf('+%d minutes', max(0, $closeMinutes)));
        $now = new \DateTimeImmutable('now', $zone);
        if ($now < $opensAt || $now > $closesAt) {
            Response::fail('checkout_closed', 'This event is outside its check-out window.', 409);
        }
    }

    public function listReenrollmentRequests(?int $studentId = null): array
    {
        $sql = 'SELECT id, student_id, reason, status, created_at FROM reenrollment_requests';
        $params = [];
        if ($studentId !== null) {
            $sql .= ' WHERE student_id = :student_id';
            $params['student_id'] = $studentId;
        }
        $sql .= ' ORDER BY created_at DESC, id DESC';
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return array_map(static fn(array $row): array => [
            'id' => (int) $row['id'],
            'studentId' => (int) $row['student_id'],
            'reason' => $row['reason'],
            'status' => $row['status'],
            'date' => substr((string) $row['created_at'], 0, 10),
        ], $stmt->fetchAll());
    }

    public function createReenrollmentRequest(int $studentId, string $reason): array
    {
        $reason = trim($reason);
        if ($reason === '' || strlen($reason) > 5000) {
            Response::fail('invalid_field', 'Request reason must be between 1 and 5000 characters.', 422);
        }
        $this->db->beginTransaction();
        try {
            $student = $this->db->prepare('SELECT user_id FROM students WHERE user_id = :id FOR UPDATE');
            $student->execute(['id' => $studentId]);
            if ($student->fetchColumn() === false) {
                $this->db->rollBack();
                Response::fail('not_found', 'Student not found.', 404);
            }
            $pending = $this->db->prepare(
                "SELECT 1 FROM reenrollment_requests WHERE student_id = :student_id AND status = 'pending' LIMIT 1"
            );
            $pending->execute(['student_id' => $studentId]);
            if ($pending->fetchColumn() !== false) {
                $this->db->rollBack();
                Response::fail('request_pending', 'A re-enrollment request is already pending.', 409);
            }
            $insert = $this->db->prepare(
                'INSERT INTO reenrollment_requests (student_id, reason) VALUES (:student_id, :reason)'
            );
            $insert->execute(['student_id' => $studentId, 'reason' => $reason]);
            $this->db->commit();
        } catch (PDOException $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
        $newRequest = $this->listReenrollmentRequests($studentId)[0];
        $this->writeAudit('create', 'reenrollment_requests', $newRequest['id'], null, $newRequest, $studentId, null, null);
        return $newRequest;
    }

    public function reviewReenrollmentRequest(int $requestId, string $decision, array $admin): array
    {
        if (!in_array($decision, ['approved', 'denied'], true)) {
            Response::fail('invalid_field', 'Request review decision is invalid.', 422);
        }
        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare('SELECT id, student_id, status FROM reenrollment_requests WHERE id = :id FOR UPDATE');
            $stmt->execute(['id' => $requestId]);
            $request = $stmt->fetch();
            if ($request === false) {
                $this->db->rollBack();
                Response::fail('not_found', 'Student request not found.', 404);
            }
            if ($request['status'] !== 'pending') {
                $this->db->rollBack();
                Response::fail('invalid_transition', 'This request has already been reviewed.', 409);
            }
            $update = $this->db->prepare(
                'UPDATE reenrollment_requests
                    SET status = :status, reviewed_by = :reviewer, reviewed_at = NOW()
                  WHERE id = :id'
            );
            $update->execute([
                'status' => $decision,
                'reviewer' => (int) $admin['id'],
                'id' => $requestId,
            ]);
            $this->db->commit();
        } catch (PDOException $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
        $updated = null;
        foreach ($this->listReenrollmentRequests((int) $request['student_id']) as $row) {
            if ((int) $row['id'] === $requestId) {
                $updated = $row;
                break;
            }
        }
        if ($updated) {
            $this->writeAudit('update', 'reenrollment_requests', $requestId, ['status' => 'pending'], ['status' => $decision], $admin['id'] ?? null, null, null);
        }
        return $updated ?? Response::fail('server_error', 'Reviewed request could not be loaded.', 500);
    }

    /* ── Row mapping ───────────────────────────────────────────── */

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private function mapUser(array $row): array
    {
        $displayName = trim((string) ($row['display_name'] ?? ''));

        if ($displayName === '') {
            $displayName = isset($row['first_name'])
                ? trim(($row['first_name'] ?? '') . ' ' . ($row['last_name'] ?? ''))
                : '';
        }
        if ($displayName === '') {
            $displayName = (string) $row['email'];
        }

        // Normalise academic identity on every read. This repairs legacy
        // rows whose department was left as "Unassigned" and guarantees a
        // BSN student is never shown under Computer Studies.
        $program = $row['program'] ?? null;
        $department = $row['department'] ?? null;
        if ($program !== null && trim((string) $program) !== '') {
            $program = ProgramCatalog::normalizeProgram((string) $program)
                ?? trim((string) $program);
            $department = ProgramCatalog::departmentForProgram($program)
                ?? ProgramCatalog::normalizeDepartment((string) $department)
                ?? 'Unassigned';
        } elseif ($department !== null) {
            $department = ProgramCatalog::normalizeDepartment((string) $department)
                ?? trim((string) $department);
        }

        return [
            'id'                 => (int) $row['id'],
            'publicId'           => $row['public_id'] ?? null,
            'role'               => Auth::clientRole((string) $row['role']),
            'email'              => $row['email'],
            'contactNumber'      => $row['contact_number'] ?? null,
            'lastPasswordChange' => $row['last_password_change'] ?? null,
            'name'               => $displayName,
            'displayName'        => $displayName,
            'status'             => $row['status'],
            'mustChangePassword' => (bool) (int) ($row['must_change_password'] ?? 0),
            'studentIdNumber'    => $row['student_id_number'] ?? null,
            'department'         => $department,
            'program'            => $program,
            'yearLevel'          => $row['year_level'] ?? null,
            'block'              => $row['block'] ?? null,
            'approvedBy'         => isset($row['approved_by']) && $row['approved_by'] !== null
                ? (int) $row['approved_by']
                : null,
            'approvedAt'         => $row['approved_at'] ?? null,
            'position'           => $row['position'] ?? null,
            'officerStatus'      => $row['officer_status'] ?? null,
        ];
    }

    /**
     * Publish an event announcement to that event's audience.
     *
     * Staff always receive it because they operate check-in; students only
     * when the event targets their department (or targets everyone).
     */
    private function announceEvent(
        int $eventId,
        string $name,
        string $venue,
        string $date,
        string $start,
        ?string $targetDepartment
    ): void {
        $notify = $this->db->prepare(
            "INSERT INTO notifications (user_id, type, message, related_entity_type, related_entity_id)
             SELECT u.id, 'announcement', :message, 'announcement:event', :event_id
             FROM users u
             LEFT JOIN students s ON s.user_id = u.id
             WHERE u.status = 'active'
               AND (:target_audience IS NULL OR s.user_id IS NULL OR s.department = :target_department)"
        );
        $notify->execute([
            'message' => $this->eventAnnouncementMessage($name, $venue, $date, $start),
            'event_id' => $eventId,
            'target_audience' => $targetDepartment,
            'target_department' => $targetDepartment,
        ]);
    }

    /**
     * Keep a published announcement's text in step with an edited event.
     */
    private function refreshEventAnnouncement(
        int $eventId,
        string $name,
        string $venue,
        string $date,
        string $start
    ): void {
        $stmt = $this->db->prepare(
            "UPDATE notifications SET message = :message
             WHERE related_entity_type = 'announcement:event' AND related_entity_id = :id"
        );
        $stmt->execute([
            'message' => $this->eventAnnouncementMessage($name, $venue, $date, $start),
            'id' => $eventId,
        ]);
    }

    private function clearEventAnnouncements(int $eventId): void
    {
        $stmt = $this->db->prepare(
            "DELETE FROM notifications
             WHERE related_entity_type = 'announcement:event' AND related_entity_id = :id"
        );
        $stmt->execute(['id' => $eventId]);
    }

    private function eventAnnouncementMessage(string $name, string $venue, string $date, string $start): string
    {
        return json_encode([
            'title' => $name . ' has been announced',
            'detail' => $venue . ' - ' . $date . ' at ' . $start,
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    }

    /**
     * True when an event's target audience includes the given department.
     * An untargeted (null/blank) event belongs to every department.
     */
    private function eventTargetsDepartment(?string $targetDepartment, string $department): bool
    {
        $target = trim((string) $targetDepartment);
        if ($target === '') {
            return true;
        }
        $normalizedTarget = ProgramCatalog::normalizeDepartment($target) ?? $target;
        $normalizedDepartment = ProgramCatalog::normalizeDepartment($department) ?? trim($department);
        return $normalizedDepartment !== '' && strcasecmp($normalizedTarget, $normalizedDepartment) === 0;
    }

    /**
     * Validate the attendance type enum value.
     */
    private function validateAttendanceType(mixed $value, int $invalidStatus = 422): string
    {
        $value = strtolower(trim((string) $value));
        if (!in_array($value, ['single', 'in_out', 'four_point'], true)) {
            Response::fail('invalid_field', 'Field "attendanceType" must be single, in_out, or four_point.', $invalidStatus);
        }
        return $value;
    }

    /**
     * Validate a database-bound string length without silently truncating it.
     */
    private function assertMaxLength(string $value, int $max, string $field, int $invalidStatus = 422): void
    {
        $length = preg_match_all('/./us', $value, $matches);
        if ($length === false || $length > $max) {
            Response::fail('invalid_field', "Field \"$field\" is too long.", $invalidStatus);
        }
    }

    private function mapEvent(array $row): array
    {
        // The schema calls this mandatory/optional; the UI's event type is
        // major/minor and it also carries a redundant `mandatory` flag
        // (see loadEventsTable in js/ssc.js). Translating here keeps the
        // database vocabulary out of the markup and stops a hydrated event
        // from rendering as "Optional" with a neutral badge.
        $mandatory = $row['event_type'] === 'mandatory';
        $category = $this->eventCategoryFromRow($row);

        return [
            'id'          => (int) $row['id'],
            'publicId'    => $row['public_id'] ?? null,
            'name'        => $row['name'],
            'description' => $row['description'],
            'date'        => $row['event_date'],
            'time'        => substr((string) $row['start_time'], 0, 5),
            'startTime'   => substr((string) $row['start_time'], 0, 5),
            'endTime'     => substr((string) $row['end_time'], 0, 5),
            // Per-event check-out offsets, anchored to end_time.
            'checkoutOpenMinutes'  => (int) ($row['checkout_open_minutes'] ?? 60),
            'checkoutCloseMinutes' => (int) ($row['checkout_close_minutes'] ?? 60),
            // The UI column is "location", never "venue".
            'location'    => $row['venue'],
            // event_category drives the matrix header; `type` stays the
            // UI's major/minor badge value. Mandatory remains a separate
            // concept (a flag-raising can be minor but still required).
            'category'    => $category,
            'type'        => $category,
            'mandatory'   => $mandatory,
            'semester'    => $row['semester'] ?? 'N/A',
            'targetDepartment' => $row['target_department'] ?? null,
            'attendanceType' => $row['attendance_type'] ?? 'single',
            // No column stores the recurrence rule; the UI hides the badge
            // when this is falsy, so null is the honest value.
            'recurring'   => null,
            'status'      => $row['status'],
        ];
    }

    /**
     * The frontend models a check-in as a table row with eventId, date,
     * time and a present/late status; the schema stores a timestamp and a
     * verification method, so those are derived here.
     *
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private function mapAttendance(array $row, int $lateGraceMinutes = 15): array
    {
        $checkIn = (string) $row['check_in_time'];
        $time    = substr($checkIn, 11, 5); // "HH:MM:SS" out of the timestamp
        $checkOut = $row['check_out_time'] ?? null;
        $eventDate = (string) ($row['event_date'] ?? substr($checkIn, 0, 10));
        $eventStart = substr((string) ($row['start_time'] ?? '00:00'), 0, 8);
        $scheduledStart = new \DateTimeImmutable($eventDate . ' ' . $eventStart);
        $lateCutoff = $scheduledStart->modify('+' . max(0, $lateGraceMinutes) . ' minutes');
        $actualCheckIn = new \DateTimeImmutable($checkIn);
        $status  = $actualCheckIn > $lateCutoff ? 'late' : 'present';

        return [
            'id'                 => (int) $row['id'],
            'eventId'            => (int) $row['event_id'],
            'eventPublicId'      => $row['event_public_id'] ?? null,
            'studentId'          => (int) $row['student_id'],
            'studentPublicId'    => $row['student_public_id'] ?? null,
            'studentIdNumber'    => $row['student_id_number'] ?? null,
            'date'               => substr($checkIn, 0, 10),
            'time'               => $time,
            'checkOutTime'       => $checkOut,
            'checkOutTimeLabel'  => $checkOut !== null ? substr((string) $checkOut, 11, 5) : null,
            'checkedOut'         => $checkOut !== null,
            'status'             => $status,
            'verificationMethod' => $row['verification_method'],
            'scanNumber'         => (int) ($row['scan_number'] ?? 0),
        ];
    }

    /**
     * Enrich an attendance row with the student and event labels the report
     * table prints. Status stays lowercase for API consistency; the explicit
     * statusLabel is the Present/Late value shown to staff.
     *
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private function mapAttendanceReport(array $row, int $lateGraceMinutes = 15): array
    {
        $record = $this->mapAttendance($row, $lateGraceMinutes);

        $name = trim((string) ($row['first_name'] ?? '') . ' ' . (string) ($row['last_name'] ?? ''));
        $program = $row['program'] ?? null;
        $department = $row['department'] ?? null;

        if ($program !== null && trim((string) $program) !== '') {
            $program = ProgramCatalog::normalizeProgram((string) $program)
                ?? trim((string) $program);
            $department = ProgramCatalog::departmentForProgram($program)
                ?? ProgramCatalog::normalizeDepartment((string) $department)
                ?? 'Unassigned';
        } elseif ($department !== null) {
            $department = ProgramCatalog::normalizeDepartment((string) $department)
                ?? trim((string) $department);
        }

        $record['studentName'] = $name !== '' ? $name : 'Unknown student';
        $record['department'] = $department ?? 'Unassigned';
        $record['program'] = $program ?? 'Unassigned';
        $record['yearLevel'] = $row['year_level'] ?? null;
        $record['block'] = $row['block'] ?? null;
        $record['eventName'] = $row['event_name'] ?? null;
        $record['eventDate'] = $row['event_date'] ?? null;
        $record['eventSemester'] = $row['semester'] ?? null;
        $record['eventStartTime'] = isset($row['start_time'])
            ? substr((string) $row['start_time'], 0, 5)
            : null;
        $record['eventEndTime'] = isset($row['end_time'])
            ? substr((string) $row['end_time'], 0, 5)
            : null;
        $record['eventCategory'] = $this->eventCategoryFromRow($row);
        $record['checkInTime'] = $row['check_in_time'] ?? null;
        $record['statusLabel'] = $record['status'] === 'late' ? 'Late' : 'Present';

        return $record;
    }

    }

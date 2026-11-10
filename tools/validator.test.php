<?php
/**
 * ATTENDLY — Validator Tests
 *
 * Run: php tools/validator.test.php
 */

declare(strict_types=1);

require __DIR__ . '/../attendly-backend/src/Validator.php';

use Attendly\ValidationException;
use Attendly\Validator;

error_reporting(E_ALL);
set_error_handler(static function (int $severity, string $message, string $file, int $line): void {
    throw new ErrorException($message, 0, $severity, $file, $line);
});

$passed = 0;
$failed = 0;

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

function validationFailure(string $code, callable $fn, ?string $messagePart = null): void
{
    try {
        $fn();
    } catch (ValidationException $e) {
        same($code, $e->errorCode);
        same(422, $e->status);
        if ($messagePart !== null && !str_contains($e->getMessage(), $messagePart)) {
            throw new RuntimeException(
                'message missing ' . var_export($messagePart, true) . ': ' . $e->getMessage()
            );
        }
        return;
    }

    throw new RuntimeException('expected ValidationException');
}

fwrite(STDOUT, "validator.test.php\n");

test('name trims surrounding whitespace', function (): void {
    same('John Doe', Validator::name('  John Doe  '));
});

test('name accepts Unicode letters and name punctuation', function (): void {
    same("María O'Connor-Smith Jr.", Validator::name("María O'Connor-Smith Jr."));
});

test('name accepts combining marks', function (): void {
    same("Jose\u{0301}", Validator::name("Jose\u{0301}"));
});

test('name accepts 150 characters', function (): void {
    $name = str_repeat('é', Validator::NAME_MAX_LENGTH);
    same($name, Validator::name($name));
});

test('name rejects fewer than 2 characters', function (): void {
    validationFailure('invalid_field', fn() => Validator::name('A'), 'between 2 and 150');
});

test('name rejects more than 150 characters', function (): void {
    validationFailure(
        'invalid_field',
        fn() => Validator::name(str_repeat('a', Validator::NAME_MAX_LENGTH + 1)),
        'between 2 and 150'
    );
});

test('name rejects digits', function (): void {
    validationFailure(
        'invalid_field',
        fn() => Validator::name('John2 Doe'),
        'letters, spaces, apostrophes, hyphens, and periods'
    );
});

test('name rejects non-strings', function (): void {
    validationFailure('invalid_field', fn() => Validator::name(['John Doe']), 'required');
});

test('email trims and lowercases', function (): void {
    same('student@example.com', Validator::email(' Student@Example.COM '));
});

test('email accepts a tagged address', function (): void {
    same('user+tag@example.co.uk', Validator::email('user+tag@example.co.uk'));
});

test('email rejects malformed addresses', function (): void {
    validationFailure('invalid_field', fn() => Validator::email('not-an-email'), 'valid email');
});

test('email rejects more than 190 characters', function (): void {
    validationFailure(
        'invalid_field',
        fn() => Validator::email(str_repeat('a', 180) . '@example.com'),
        '190 characters or fewer'
    );
});

test('email rejects non-strings', function (): void {
    validationFailure('invalid_field', fn() => Validator::email(['student@example.com']), 'required');
});

test('email reports the custom field name', function (): void {
    validationFailure('invalid_field', fn() => Validator::email('bad', 'contactEmail'), 'contactEmail');
});

test('student id accepts the seeded format', function (): void {
    same('2023-00001', Validator::studentIdNumber('2023-00001'));
});

test('student id trims surrounding whitespace', function (): void {
    same('2026-00002', Validator::studentIdNumber(' 2026-00002 '));
});

test('student id rejects missing hyphen', function (): void {
    validationFailure('invalid_field', fn() => Validator::studentIdNumber('202300001'), 'YYYY-NNNNN');
});

test('student id rejects short sequence', function (): void {
    validationFailure('invalid_field', fn() => Validator::studentIdNumber('2023-0001'), 'YYYY-NNNNN');
});

test('student id rejects long sequence', function (): void {
    validationFailure('invalid_field', fn() => Validator::studentIdNumber('2023-000001'), 'YYYY-NNNNN');
});

test('student id rejects non-digits', function (): void {
    validationFailure('invalid_field', fn() => Validator::studentIdNumber('abcd-efghi'), 'YYYY-NNNNN');
});

test('student id rejects non-strings', function (): void {
    validationFailure('invalid_field', fn() => Validator::studentIdNumber(202300001), 'required');
});

test('password accepts a policy-compliant value', function (): void {
    same('Password1', Validator::password('Password1'));
});

test('password preserves surrounding whitespace', function (): void {
    same('  space pass1  ', Validator::password('  space pass1  '));
});

test('password accepts exactly 72 bytes', function (): void {
    $password = str_repeat('a', Validator::PASSWORD_MAX_BYTES - 1) . '1';
    same($password, Validator::password($password));
});

test('password rejects fewer than 8 bytes', function (): void {
    validationFailure('weak_password', fn() => Validator::password('Pass1'), 'at least 8');
});

test('password rejects more than 72 bytes', function (): void {
    validationFailure(
        'weak_password',
        fn() => Validator::password(str_repeat('a', Validator::PASSWORD_MAX_BYTES) . '1'),
        '72 bytes or fewer'
    );
});

test('password requires a letter', function (): void {
    validationFailure('weak_password', fn() => Validator::password('12345678'), 'one letter and one digit');
});

test('password requires a digit', function (): void {
    validationFailure('weak_password', fn() => Validator::password('abcdefgh'), 'one letter and one digit');
});

test('password rejects an empty string', function (): void {
    validationFailure('invalid_field', fn() => Validator::password(''), 'required');
});

test('password rejects non-strings', function (): void {
    validationFailure('invalid_field', fn() => Validator::password(12345678), 'required');
});

test('event id accepts an integer', function (): void {
    same(5, Validator::eventId(5));
});

test('event id accepts a numeric string with leading zeroes', function (): void {
    same(5, Validator::eventId('0005'));
});

test('event id trims a numeric string', function (): void {
    same(42, Validator::eventId(' 42 '));
});

test('event id rejects zero', function (): void {
    validationFailure('invalid_field', fn() => Validator::eventId(0), 'positive whole number');
});

test('event id rejects negatives', function (): void {
    validationFailure('invalid_field', fn() => Validator::eventId(-1), 'positive whole number');
});

test('event id rejects non-numeric strings', function (): void {
    validationFailure('invalid_field', fn() => Validator::eventId('abc'), 'positive whole number');
});

test('event id rejects floats', function (): void {
    validationFailure('invalid_field', fn() => Validator::eventId(1.0), 'positive whole number');
});

test('event id rejects booleans', function (): void {
    validationFailure('invalid_field', fn() => Validator::eventId(true), 'positive whole number');
});

test('event id rejects values above the unsigned int range', function (): void {
    validationFailure('invalid_field', fn() => Validator::eventId('4294967296'), 'positive whole number');
});

test('event id rejects arrays', function (): void {
    validationFailure('invalid_field', fn() => Validator::eventId([]), 'positive whole number');
});

test('descriptor accepts exactly 128 finite numbers', function (): void {
    $descriptor = array_fill(0, Validator::DESCRIPTOR_LENGTH, 0.5);
    $validated = Validator::descriptor($descriptor);

    same(Validator::DESCRIPTOR_LENGTH, count($validated));
    same(0.5, $validated[0]);
    same(true, is_float($validated[0]));
});

test('descriptor casts integers to floats', function (): void {
    $validated = Validator::descriptor(array_fill(0, Validator::DESCRIPTOR_LENGTH, 1));

    same(1.0, $validated[0]);
    same(true, is_float($validated[0]));
});

test('descriptor rejects fewer than 128 numbers', function (): void {
    validationFailure(
        'invalid_field',
        fn() => Validator::descriptor(array_fill(0, Validator::DESCRIPTOR_LENGTH - 1, 0.5)),
        'exactly 128'
    );
});

test('descriptor rejects more than 128 numbers', function (): void {
    validationFailure(
        'invalid_field',
        fn() => Validator::descriptor(array_fill(0, Validator::DESCRIPTOR_LENGTH + 1, 0.5)),
        'exactly 128'
    );
});

test('descriptor rejects numeric strings', function (): void {
    $descriptor = array_fill(0, Validator::DESCRIPTOR_LENGTH, 0.5);
    $descriptor[64] = '0.5';

    validationFailure('invalid_field', fn() => Validator::descriptor($descriptor), 'finite numbers');
});

test('descriptor rejects NAN', function (): void {
    $descriptor = array_fill(0, Validator::DESCRIPTOR_LENGTH, 0.5);
    $descriptor[64] = NAN;

    validationFailure('invalid_field', fn() => Validator::descriptor($descriptor), 'finite numbers');
});

test('descriptor rejects INF', function (): void {
    $descriptor = array_fill(0, Validator::DESCRIPTOR_LENGTH, 0.5);
    $descriptor[64] = INF;

    validationFailure('invalid_field', fn() => Validator::descriptor($descriptor), 'finite numbers');
});

test('descriptor rejects associative arrays', function (): void {
    validationFailure(
        'invalid_field',
        fn() => Validator::descriptor(array_fill(0, Validator::DESCRIPTOR_LENGTH, 0.5) + ['extra' => 1]),
        'list of 128'
    );
});

test('descriptor rejects non-arrays', function (): void {
    validationFailure('invalid_field', fn() => Validator::descriptor('not-an-array'), 'list of 128');
});

fwrite(STDOUT, "\n{$passed} validator assertions passed.\n");

if ($failed > 0) {
    fwrite(STDERR, "{$failed} validator assertion(s) failed.\n");
    exit(1);
}

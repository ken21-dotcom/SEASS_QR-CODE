<?php
/**
 * ATTENDLY — Input Validation
 *
 * Validation rules live here so they can be unit-tested without emitting
 * an HTTP response. The HTTP layer translates ValidationException to
 * Response::fail() with the same code, message, and status.
 */

declare(strict_types=1);

namespace Attendly;

final class ValidationException extends \RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly int $status = 422
    ) {
        parent::__construct($message);
    }
}

final class Validator
{
    public const NAME_MIN_LENGTH = 2;
    public const NAME_MAX_LENGTH = 150;
    public const EMAIL_MAX_LENGTH = 190;
    public const PASSWORD_MIN_BYTES = 8;
    public const PASSWORD_MAX_BYTES = 72;
    public const DESCRIPTOR_LENGTH = 128;
    public const MAX_DATABASE_ID = 4294967295;

    public static function name(mixed $value, string $field = 'name'): string
    {
        $name = self::stringValue($value, $field);

        if (!mb_check_encoding($name, 'UTF-8')) {
            self::invalid($field, 'must be valid UTF-8.');
        }

        $length = mb_strlen($name, 'UTF-8');
        if ($length < self::NAME_MIN_LENGTH || $length > self::NAME_MAX_LENGTH) {
            self::invalid($field, sprintf(
                'must be between %d and %d characters.',
                self::NAME_MIN_LENGTH,
                self::NAME_MAX_LENGTH
            ));
        }

        if (preg_match('/^[\p{L}\p{M}][\p{L}\p{M} .\'\-]*\z/u', $name) !== 1) {
            self::invalid($field, 'may contain only letters, spaces, apostrophes, hyphens, and periods.');
        }

        return $name;
    }

    public static function nameOrUnknown(mixed $value, string $field = 'name'): string
    {
        $name = self::stringValue($value, $field);

        if (!mb_check_encoding($name, 'UTF-8')) {
            return 'Unknown';
        }

        $length = mb_strlen($name, 'UTF-8');
        if ($length < self::NAME_MIN_LENGTH || $length > self::NAME_MAX_LENGTH) {
            return 'Unknown';
        }

        if (preg_match('/^[\p{L}\p{M}][\p{L}\p{M} .\'\-]*\z/u', $name) !== 1) {
            return 'Unknown';
        }

        return $name;
    }

    public static function nameOrUnknownCaseInsensitive(mixed $value, string $field = 'name'): string
    {
        $name = self::stringValue($value, $field);

        if (!mb_check_encoding($name, 'UTF-8')) {
            return 'Unknown';
        }

        $length = mb_strlen($name, 'UTF-8');
        if ($length < self::NAME_MIN_LENGTH || $length > self::NAME_MAX_LENGTH) {
            return 'Unknown';
        }

        if (preg_match('/^[\p{L}\p{M}][\p{L}\p{M} .\'\-]*\z/iu', $name) !== 1) {
            return 'Unknown';
        }

        return mb_convert_case($name, MB_CASE_TITLE, 'UTF-8');
    }

    public static function normalizeName(mixed $value, string $field = 'name'): string
    {
        $name = self::stringValue($value, $field);

        if (mb_strlen($name, 'UTF-8') === 0) {
            return 'Unknown';
        }

        if (!mb_check_encoding($name, 'UTF-8')) {
            return 'Unknown';
        }

        $length = mb_strlen($name, 'UTF-8');
        if ($length < self::NAME_MIN_LENGTH || $length > self::NAME_MAX_LENGTH) {
            return 'Unknown';
        }

        if (preg_match('/^[\p{L}\p{M}][\p{L}\p{M} .\'\-]*\z/iu', $name) !== 1) {
            return 'Unknown';
        }

        return mb_convert_case($name, MB_CASE_TITLE, 'UTF-8');
    }

    public static function email(mixed $value, string $field = 'email'): string
    {
        $email = self::stringValue($value, $field);

        if (mb_strlen($email, 'UTF-8') > self::EMAIL_MAX_LENGTH) {
            self::invalid($field, sprintf('must be %d characters or fewer.', self::EMAIL_MAX_LENGTH));
        }

        $email = strtolower($email);
        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            self::invalid($field, 'must be a valid email address.');
        }

        return $email;
    }

    public static function studentIdNumber(mixed $value, string $field = 'studentIdNumber'): string
    {
        $studentId = self::stringValue($value, $field);

        if (preg_match('/^\d{4}-\d{5}\z/', $studentId) !== 1) {
            self::invalid($field, 'must use the format YYYY-NNNNN.');
        }

        return $studentId;
    }

    /**
     * Validate a student block/cohort label such as "A", "1-A", or "BSIT 2B".
     */
    public static function block(mixed $value, string $field = 'block'): string
    {
        $block = self::stringValue($value, $field);

        if (!mb_check_encoding($block, 'UTF-8')) {
            self::invalid($field, 'must be valid UTF-8.');
        }

        if (mb_strlen($block, 'UTF-8') > 30) {
            self::invalid($field, 'must be 30 characters or fewer.');
        }

        if (preg_match('/^[\p{L}\p{N}][\p{L}\p{N} .\-\/]*\z/u', $block) !== 1) {
            self::invalid($field, 'may contain only letters, numbers, spaces, hyphens, periods, and slashes.');
        }

        return $block;
    }

    public static function password(mixed $value, string $field = 'password'): string
    {
        if (!is_string($value) || $value === '') {
            throw new ValidationException('invalid_field', sprintf('Field "%s" is required.', $field));
        }

        $length = strlen($value);
        if ($length < self::PASSWORD_MIN_BYTES) {
            self::weak($field, sprintf('must be at least %d characters.', self::PASSWORD_MIN_BYTES));
        }
        if ($length > self::PASSWORD_MAX_BYTES) {
            self::weak($field, sprintf('must be %d bytes or fewer.', self::PASSWORD_MAX_BYTES));
        }
        if (preg_match('/[A-Za-z]/', $value) !== 1 || preg_match('/[0-9]/', $value) !== 1) {
            self::weak($field, 'must contain at least one letter and one digit.');
        }

        return $value;
    }

    public static function eventId(mixed $value, string $field = 'eventId'): int
    {
        if (is_string($value)) {
            $value = trim($value);
            if ($value === '' || !ctype_digit($value)) {
                self::invalid($field, 'must be a positive whole number.');
            }
            $value = ltrim($value, '0');
            if ($value === '') {
                self::invalid($field, 'must be a positive whole number.');
            }
        } elseif (!is_int($value)) {
            self::invalid($field, 'must be a positive whole number.');
        }

        $id = filter_var($value, FILTER_VALIDATE_INT, [
            'options' => [
                'min_range' => 1,
                'max_range' => self::MAX_DATABASE_ID,
            ],
        ]);

        if ($id === false) {
            self::invalid($field, 'must be a positive whole number.');
        }

        return $id;
    }

    /**
     * @return list<float>
     */
    public static function descriptor(mixed $value, string $field = 'descriptor'): array
    {
        if (!is_array($value) || !array_is_list($value)) {
            self::invalid($field, sprintf('must be a list of %d numbers.', self::DESCRIPTOR_LENGTH));
        }

        if (count($value) !== self::DESCRIPTOR_LENGTH) {
            self::invalid($field, sprintf('must contain exactly %d numbers.', self::DESCRIPTOR_LENGTH));
        }

        $descriptor = [];
        foreach ($value as $component) {
            if (!is_int($component) && !is_float($component)) {
                self::invalid($field, 'must contain only finite numbers.');
            }
            if (is_float($component) && !is_finite($component)) {
                self::invalid($field, 'must contain only finite numbers.');
            }
            $descriptor[] = (float) $component;
        }

        return $descriptor;
    }

    private static function stringValue(mixed $value, string $field): string
    {
        if (!is_string($value) || trim($value) === '') {
            throw new ValidationException('invalid_field', sprintf('Field "%s" is required.', $field));
        }

        return trim($value);
    }

    private static function invalid(string $field, string $reason): never
    {
        throw new ValidationException('invalid_field', sprintf('Field "%s" %s', $field, $reason));
    }

    private static function weak(string $field, string $reason): never
    {
        throw new ValidationException('weak_password', sprintf('Field "%s" %s', $field, $reason));
    }
}

<?php
/**
 * ATTENDLY — Academic program catalogue
 *
 * A student's school is derived from their program, never chosen
 * independently. The same mapping is mirrored in js/data.js so the
 * dashboard groups records consistently even before a database cleanup.
 */

declare(strict_types=1);

namespace Attendly;

final class ProgramCatalog
{
    /** Canonical program code => school and display label. */
    public const PROGRAMS = [
        'BSIT' => [
            'department' => 'School of Computer Studies',
            'label'      => 'BSIT – Bachelor of Science in Information Technology',
        ],
        'BSN' => [
            'department' => 'School of Nursing',
            'label'      => 'BSN – Bachelor of Science in Nursing',
        ],
        'BSEntrep' => [
            'department' => 'School of Business Management',
            'label'      => 'BSEntrep – Bachelor of Science in Entrepreneurship',
        ],
        'BSHM' => [
            'department' => 'School of Business Management',
            'label'      => 'BSHM – Bachelor of Science in Hospitality Management',
        ],
        'BSTM' => [
            'department' => 'School of Business Management',
            'label'      => 'BSTM – Bachelor of Science in Tourism Management',
        ],
    ];

    /**
     * Resolve a stored/legacy program value to its canonical short code.
     * Accepts "BSIT", "BSIT – Bachelor ...", "BSE – ...", etc.
     */
    public static function normalizeProgram(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $raw = trim($value);
        if ($raw === '') {
            return null;
        }

        $upper = strtoupper(str_replace(['–', '—', '−'], '-', $raw));
        $upper = preg_replace('/\s+/', ' ', $upper) ?? $upper;
        $head = trim((string) preg_split('/\s*-\s*/', $upper, 2)[0]);

        $aliases = [
            'BSIT'     => 'BSIT',
            'BSN'      => 'BSN',
            'BSENTREP' => 'BSEntrep',
            'BSE'      => 'BSEntrep',
            'BSHM'     => 'BSHM',
            'BSTM'     => 'BSTM',
        ];
        if (isset($aliases[$head])) {
            return $aliases[$head];
        }

        if (str_contains($upper, 'INFORMATION TECHNOLOGY')) {
            return 'BSIT';
        }
        if (str_contains($upper, 'NURSING')) {
            return 'BSN';
        }
        if (str_contains($upper, 'ENTREPRENEURSHIP')) {
            return 'BSEntrep';
        }
        if (str_contains($upper, 'HOSPITALITY MANAGEMENT')) {
            return 'BSHM';
        }
        if (str_contains($upper, 'TOURISM MANAGEMENT')) {
            return 'BSTM';
        }

        return null;
    }

    /** Canonical school for a program, or null when the program is unknown. */
    public static function departmentForProgram(?string $program): ?string
    {
        $code = self::normalizeProgram($program);
        return $code === null ? null : self::PROGRAMS[$code]['department'];
    }

    /** Resolve legacy school names to the canonical school. */
    public static function normalizeDepartment(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $key = strtoupper(trim($value));
        if ($key === '') {
            return null;
        }
        $key = preg_replace('/\s*\x28[^\x29]*\x29\s*/', ' ', $key) ?? $key;
        $key = preg_replace('/\s+/', ' ', $key) ?? $key;
        $key = trim($key);

        $aliases = [
            'SCHOOL OF COMPUTER STUDIES'           => 'School of Computer Studies',
            'SCHOOL OF COMPUTING STUDIES'          => 'School of Computer Studies',
            'COLLEGE OF COMPUTER STUDIES'          => 'School of Computer Studies',
            'COLLEGE OF INFORMATION TECHNOLOGY'    => 'School of Computer Studies',
            'SCS'                                  => 'School of Computer Studies',
            'SCHOOL OF NURSING'                    => 'School of Nursing',
            'COLLEGE OF NURSING'                   => 'School of Nursing',
            'SON'                                  => 'School of Nursing',
            'SCHOOL OF BUSINESS MANAGEMENT'        => 'School of Business Management',
            'SCHOOL OF BUSINESS AND ADMINISTRATION' => 'School of Business Management',
            'SCHOOL OF BUSINESS AND MANAGEMENT'    => 'School of Business Management',
            'COLLEGE OF BUSINESS'                  => 'School of Business Management',
            'SBM'                                  => 'School of Business Management',
        ];

        return $aliases[$key] ?? null;
    }

    /** Full display label for a canonical program code. */
    public static function label(string $program): string
    {
        return self::PROGRAMS[$program]['label'] ?? $program;
    }
}

/* Cross-boundary contract tests: PHP Repository mappers <-> frontend consumers.
 *
 * These mirror the mapper logic in attendly-backend/src/Repository.php and
 * assert every value can be consumed by the JS that reads it. They are a
 * guard against vocabulary drift across the API boundary.
 *
 * Run: node tools/api-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    pass++;
  } else {
    failures.push(name + (detail ? ' -> ' + detail : ''));
  }
}

/* ── Mirrors of the PHP mappers ─────────────────────────────────── */

const clientRole = (db) => ({ administrator: 'admin', ssc_officer: 'ssc-officer' }[db] ?? db);

function mapAttendance(row) {
  const checkIn = String(row.check_in_time);
  const time = checkIn.slice(11, 16);
  const status = time > '08:15' ? 'late' : 'present';
  return {
    id: Number(row.id),
    publicId: row.public_id ?? null,
    eventId: Number(row.event_id),
    eventPublicId: row.event_public_id ?? null,
    studentId: Number(row.student_id),
    studentPublicId: row.student_public_id ?? null,
    studentIdNumber: row.student_id_number ?? null,
    date: checkIn.slice(0, 10),
    time,
    status,
    verificationMethod: row.verification_method,
  };
}

function mapSanction(row) {
  const decidedAt = String(row.decided_at);
  return {
    id: Number(row.id),
    studentId: Number(row.student_id),
    studentName: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
    studentIdNumber: row.student_id_number ?? null,
    recommendationId: row.recommendation_id != null ? Number(row.recommendation_id) : null,
    severity: row.type,
    description: row.decision_notes ?? '',
    date: decidedAt.slice(0, 10),
    status: row.lifted_at === null ? 'active' : 'resolved',
    decidedBy: Number(row.decided_by),
    liftedAt: row.lifted_at,
  };
}

function mapEvent(row) {
  const mandatory = row.event_type === 'mandatory';
  const category = row.event_category === 'major' || row.event_category === 'minor'
    ? row.event_category
    : (mandatory ? 'major' : 'minor');
  return {
    id: Number(row.id),
    publicId: row.public_id ?? null,
    name: row.name,
    description: row.description,
    date: row.event_date,
    time: String(row.start_time).slice(0, 5),
    startTime: String(row.start_time).slice(0, 5),
    endTime: String(row.end_time).slice(0, 5),
    location: row.venue,
    category,
    type: category,
    mandatory,
    recurring: null,
    status: row.status,
  };
}

// Inverse of mapEvent, mirroring api.toEventPayload in js/api.js.
function toEventPayload(uiEvent, endTime) {
  const start = uiEvent.time || '00:00';
  const [h, m] = start.split(':').map(Number);
  const total = h * 60 + m + 60;
  const end = endTime || [String(Math.floor(total / 60) % 24).padStart(2, '0'), String(total % 60).padStart(2, '0')].join(':');
  return {
    name: uiEvent.name,
    date: uiEvent.date,
    startTime: start,
    endTime: end,
    venue: uiEvent.location,
    eventType: uiEvent.mandatory === true
      ? 'mandatory'
      : (uiEvent.type === 'major' ? 'mandatory' : 'optional'),
    eventCategory: uiEvent.category || uiEvent.type || (uiEvent.mandatory === true ? 'major' : 'minor'),
    description: uiEvent.description || null,
  };
}

/* ── Frontend expectations, extracted from the real source ──────── */

const repo = read('attendly-backend/src/Repository.php');

const studentJs = read('student-attendance-system/js/student.js');
const uiJs = read('student-attendance-system/js/ui.js');
const sscJs = read('student-attendance-system/js/ssc.js');
const dataJs = read('student-attendance-system/js/data.js');
const authJs = read('student-attendance-system/js/auth.js');

/* ── 1. Roles reach a page that exists ──────────────────────────── */

const pageUrl = (role) => ({
  login: 'login.html',
  student: 'student/student-dashboard.html',
  'ssc-officer': 'ssc-officer/ssc-dashboard.html',
  admin: 'administrator/admin-dashboard.html',
}[role] ?? 'login.html');

for (const dbRole of ['student', 'ssc_officer', 'administrator']) {
  const mapped = clientRole(dbRole);
  ok(`role ${dbRole} -> ${mapped}`, mapped !== 'login.html', pageUrl(mapped));
}
for (const role of ['student', 'ssc-officer', 'admin']) {
  ok(`pageUrl handles ${role}`, authJs.includes(`case '${role}'`));
}

/* ── 2. Attendance records satisfy every field student.js reads ─── */

const att = mapAttendance({
  id: 1, event_id: 7, student_id: 42,
  check_in_time: '2026-03-04 08:40:05',
  verification_method: 'qr',
  student_id_number: 'S-042',
});

ok('attendance.studentId', typeof att.studentId === 'number');
ok('attendance.eventId', typeof att.eventId === 'number');
ok('attendance.date formatted', /^\d{4}-\d{2}-\d{2}$/.test(att.date), att.date);
ok('attendance.time HH:MM', /^\d{2}:\d{2}$/.test(att.time), att.time);
ok('attendance.status in safeToken allowlist',
  ['present', 'late', 'absent', 'excused'].includes(att.status), att.status);
ok('late threshold applied', att.status === 'late', `08:40 -> ${att.status}`);

const early = mapAttendance({ id: 2, event_id: 7, student_id: 42, check_in_time: '2026-03-04 08:00:00', verification_method: 'manual' });
ok('on-time is present', early.status === 'present', `08:00 -> ${early.status}`);

// Exactly at the boundary must count as present, not late.
const boundary = mapAttendance({ id: 3, event_id: 7, student_id: 42, check_in_time: '2026-03-04 08:15:00', verification_method: 'qr' });
ok('08:15 boundary is present', boundary.status === 'present', `08:15 -> ${boundary.status}`);

ok('student.js reads attendance.status', studentJs.includes("record.status === 'present'"));
ok('student.js reads attendance.time', studentJs.includes('record.time'));
ok('student.js reads attendance.date', studentJs.includes('formatDate(record.date)'));

/* ── 3. Sanctions are now purely mathematical ────────────────────── */

// The manual sanction workflow is removed. Sanctions are derived from
// absences: a student is sanctioned when totalAbsences > 3. The matrix
// exposes a boolean `forSanction` instead of a status enum.

const matrixRepoStart2 = repo.indexOf('function listSanctionMatrix');
const matrixRepo2 = matrixRepoStart2 === -1 ? '' : repo.slice(matrixRepoStart2, repo.indexOf('\n    }', matrixRepoStart2));
ok('matrix exposes forSanction from totalAbsences',
  matrixRepo2.includes("'forSanction'") &&
  /forSanction'\s*=>\s*\$absences\s*>\s*3/.test(matrixRepo2));
ok('matrix no longer exposes a sanction status enum',
  !matrixRepo2.includes("'sanctionStatus'") && !matrixRepo2.includes("'sanctionStatusLabel'"));
ok('manual sanction mappers are removed',
  !repo.includes('function mapSanction') && !repo.includes('function listSanctions') &&
  !repo.includes('function createSanction') && !repo.includes('function updateSanctionStatus'));

/* ── 4. Events satisfy the renderer in loadEventsTable ──────────── */

const event = mapEvent({
  id: 5, public_id: 'EVNT_005', name: 'Orientation', description: null,
  event_date: '2026-03-10', start_time: '08:00:00', end_time: '10:00:00',
  venue: 'Hall A', event_type: 'mandatory', status: 'scheduled',
});

// The authoritative list of event types is the safeToken allowlist the
// renderer passes, not the schema's enum and not our own assumptions.
const typeAllowlist = sscJs.match(/safeToken\(type,\s*\[([^\]]+)\]/);
ok('renderer passes a type allowlist to safeToken', !!typeAllowlist);
const uiTypes = typeAllowlist ? [...typeAllowlist[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

for (const t of ['major', 'minor']) {
  ok(`UI event type "${t}" is in the renderer's allowlist`, uiTypes.includes(t), uiTypes.join(','));
}

// A hydrated event must produce a token the renderer will accept.
ok('mapped mandatory type is renderable', uiTypes.includes(event.type), event.type);
ok('mapped event carries its report category', event.category === 'major', event.category);
const optionalEvent = mapEvent({ ...{ id: 6, name: 'Opt-in', event_date: '2026-03-11', start_time: '09:00:00', end_time: '10:00:00', venue: 'Hall B', event_type: 'optional', status: 'scheduled' } });
ok('mapped optional type is renderable', uiTypes.includes(optionalEvent.type), optionalEvent.type);

// A flag-raising is minor in reports but attendance is still required.
const minorMandatory = mapEvent({
  id: 7, name: 'Flag Raising', event_date: '2026-03-12',
  start_time: '07:00:00', end_time: '07:30:00', venue: 'Flagpole',
  event_type: 'mandatory', event_category: 'minor', status: 'completed',
});
ok('minor mandatory event keeps category=minor', minorMandatory.category === 'minor', minorMandatory.category);
ok('minor mandatory event keeps mandatory=true', minorMandatory.mandatory === true, String(minorMandatory.mandatory));

// The renderer prints mandatory ? 'Mandatory' : 'Optional', so a
// mandatory event must not arrive with a falsy flag.
ok('mandatory event carries mandatory=true', event.mandatory === true, String(event.mandatory));
ok('optional event carries mandatory=false', optionalEvent.mandatory === false);

// The table prints event.location; the schema column is venue.
ok('renderer reads event.location', sscJs.includes('escapeHtml(event.location)'));
ok('mapped event has location', event.location === 'Hall A');
ok('mapped event carries publicId', event.publicId === 'EVNT_005', event.publicId);
ok('mapped event has no venue key', !('venue' in event), Object.keys(event).join(','));

// recurring is read but null-guarded, so null is safe.
ok('renderer null-guards recurring', sscJs.includes('${recurring ?'));
ok('mapped recurring is falsy', !event.recurring);

// Formatters must receive a value they can parse.
ok('event.time HH:MM', /^\d{2}:\d{2}$/.test(event.time), event.time);
ok('renderer formats event.date', sscJs.includes('formatDate(event.date)'));
// Per-type absence grouping moved to the server, so data.js must not keep a
// second copy of the sanction policy.
ok('data.js has no stale sanction-policy helpers',
  !dataJs.includes('computeUnexcusedAbsences') &&
  !dataJs.includes('DEFAULT_SANCTION_POLICY'));

/* ── 4b. Write path is the exact inverse of the read path ───────── */

for (const dbRow of [
  { event_type: 'mandatory', event_category: 'major', venue: 'Hall A', start_time: '08:00:00', end_time: '09:30:00', event_date: '2026-03-10', name: 'Foundation Day', id: 1 },
  { event_type: 'optional', event_category: 'minor', venue: 'Hall B', start_time: '23:30:00', end_time: '00:30:00', event_date: '2026-03-11', name: 'Opt-in Clinic', id: 2 },
  { event_type: 'mandatory', event_category: 'minor', venue: 'Flagpole', start_time: '07:00:00', end_time: '07:30:00', event_date: '2026-03-12', name: 'Flag Raising', id: 3 },
]) {
  const roundTripped = toEventPayload(mapEvent(dbRow), mapEvent(dbRow).endTime);
  ok(`type round-trips for ${dbRow.name}`, roundTripped.eventType === dbRow.event_type, roundTripped.eventType);
  ok(`category round-trips for ${dbRow.name}`, roundTripped.eventCategory === dbRow.event_category, roundTripped.eventCategory);
  ok(`name round-trips for ${dbRow.name}`, roundTripped.name === dbRow.name);
  ok(`date round-trips for ${dbRow.name}`, roundTripped.date === dbRow.event_date);
  ok(`venue/location round-trips for ${dbRow.name}`, roundTripped.venue === dbRow.venue, roundTripped.venue);
}

// A single-time form has no end field, so the default must be sane.
ok('endTime defaults to +1h', toEventPayload({ time: '08:00' }).endTime === '09:00', toEventPayload({ time: '08:00' }).endTime);
ok('endTime wraps past midnight', toEventPayload({ time: '23:30' }).endTime === '00:30', toEventPayload({ time: '23:30' }).endTime);
ok('major maps to mandatory', toEventPayload({ type: 'major' }).eventType === 'mandatory');
ok('minor maps to optional', toEventPayload({ type: 'minor' }).eventType === 'optional');
ok('unknown type defaults to optional', toEventPayload({ type: 'weird' }).eventType === 'optional');

/* ── 5. No mapper emits snake_case to the client ────────────────── */

for (const method of ['mapUser', 'mapEvent', 'mapAttendance', 'mapAttendanceReport']) {
  const start = repo.indexOf('function ' + method);
  ok(`${method} exists`, start !== -1);
  if (start === -1) continue;
  const body = repo.slice(start, repo.indexOf('\n    }', start));
  // Keys must be camelCase; no raw column names may appear as array keys.
  const keys = [...body.matchAll(/'([a-z_]+)'\s*=>/g)].map((m) => m[1]);
  const snake = keys.filter((k) => k.includes('_'));
  ok(`${method} emits no snake_case keys`, snake.length === 0, snake.join(','));
}

const reportRepoStart = repo.indexOf('function listAttendanceReport');
const reportRepo = reportRepoStart === -1 ? '' : repo.slice(reportRepoStart, repo.indexOf('\n    }', reportRepoStart));
ok('attendance report supports all requested filters',
  reportRepo.includes("$filters['eventId']") &&
  reportRepo.includes("$filters['department']") &&
  reportRepo.includes("$filters['program']") &&
  reportRepo.includes("$filters['yearLevel']"));
ok('attendance report returns student, event, and check-in details',
  reportRepo.includes('mapAttendanceReport') &&
  /s\.student_id_number/.test(reportRepo) && /e\.name AS event_name/.test(reportRepo));

/* ── 5b. Public display identifiers ─────────────────────────────── */

const authPhp = read('attendly-backend/src/Auth.php');
const reportsJs = read('student-attendance-system/js/reports.js');
const adminJs = read('student-attendance-system/js/administrator-panel.js');
const publicIdGenerator = read('attendly-backend/src/PublicIdGenerator.php');

ok('mapUser emits publicId', /'publicId'\s*=>\s*\$row\['public_id'\]/.test(repo));
ok('mapEvent emits publicId', /publicId'\s*=>\s*\$row\['public_id'\]/.test(repo));
ok('mapAttendance emits student and event publicIds',
  repo.includes("'studentPublicId'") && repo.includes("'eventPublicId'"));
ok('listUsers selects public_id', /SELECT u\.id, u\.public_id/.test(repo));
ok('safeUser returns publicId', /'publicId'\s*=>\s*\$user\['public_id'\]/.test(authPhp));
ok('session persists publicId', /publicId:\s+user\.publicId/.test(dataJs));
// SSC tables no longer render publicId in the UI (kept in reports/exports)
ok('SSC tables do not render publicId', !sscJs.includes('student.publicId ||') && !sscJs.includes('<td>${escapeHtml(event.publicId'));
// Admin tables no longer render publicId in the UI (kept in reports/exports)
ok('admin tables do not render publicId', !adminJs.includes('officer.publicId') && !adminJs.includes('student.publicId'));
ok('reports render user and event public IDs',
  reportsJs.includes('studentPublicId') && reportsJs.includes('eventPublicId'));
ok('generator derives the next suffix from MAX, not COUNT',
  /MAX\(CAST\(SUBSTRING\(public_id/.test(publicIdGenerator) && !/SELECT\s+COUNT\(/i.test(publicIdGenerator));
ok('role prefixes are STUD/SSC/USR and EVNT',
  publicIdGenerator.includes("'student'       => 'STUD'") &&
  publicIdGenerator.includes("'ssc_officer'   => 'SSC'") &&
  publicIdGenerator.includes("'administrator' => 'USR'") &&
  publicIdGenerator.includes("EVENT_PREFIX = 'EVNT'"));

/* ── 5c. Semester attendance & sanction matrix ─────────────────── */

const routesPhp = read('attendly-backend/src/routes.php');
const apiJs = read('student-attendance-system/js/api.js');
const adminReportsHtml = read('student-attendance-system/pages/administrator/admin-reports.html');
const sscReportsHtml = read('student-attendance-system/pages/ssc-officer/ssc-reports.html');
const reportsCss = read('student-attendance-system/css/reports.css');
const dropAppeals = read('attendly-backend/db/migrations/025_drop_appeals.sql');
const eventCategoryMigration = read('attendly-backend/db/migrations/026_event_category.sql');
const seedScript = read('attendly-backend/scripts/seed-realistic-data.php');
const matrixRepoStart = repo.indexOf('function listSanctionMatrix');
const matrixRepo = matrixRepoStart === -1 ? '' : repo.slice(matrixRepoStart, repo.indexOf('\n    }', matrixRepoStart));

ok('sanction matrix repository exists', matrixRepoStart !== -1);
ok('event category migration adds the report grouping column',
  /ADD COLUMN event_category ENUM\('major','minor'\)/.test(eventCategoryMigration) &&
  /UPDATE events[\s\S]*event_category = CASE/.test(eventCategoryMigration) &&
  eventCategoryMigration.includes('idx_events_category_date'));
ok('matrix returns every event in the selected range',
  matrixRepo.includes("WHERE status <> 'cancelled'") &&
  matrixRepo.includes('event_date >= :from') &&
  matrixRepo.includes('event_date <= :to'));
ok('matrix lists every active student as a roster row',
  matrixRepo.includes("u.role = 'student' AND u.status = 'active'"));
ok('matrix derives AM/PM flags from check-in and check-out times',
  matrixRepo.includes("'amIn'") &&
  matrixRepo.includes("'amOut'") &&
  matrixRepo.includes("'pmIn'") &&
  matrixRepo.includes("'pmOut'") &&
  matrixRepo.includes('check_out_time'));
ok('matrix totals ended mandatory absences with no attendance row',
  matrixRepo.includes('$endedMandatory') &&
  matrixRepo.includes("'mandatory'") &&
  matrixRepo.includes('has_ended') &&
  matrixRepo.includes("isset($attendance[$endedEvent['id']])"));
ok('matrix ignores events targeted at another department when counting absences',
  matrixRepo.includes('target_department') &&
  matrixRepo.includes('eventTargetsDepartment'));
ok('matrix exposes event metadata plus student totals and sanction flag',
  matrixRepo.includes("'category'") &&
  matrixRepo.includes("'publicId'") &&
  matrixRepo.includes("'totalAbsences'") &&
  matrixRepo.includes("'forSanction'") &&
  matrixRepo.includes("'attendance'"));
ok('matrix route validates both inclusive date bounds',
  /'GET', '\/reports\/sanctions'[\s\S]*?requireRole\(\['admin', 'ssc-officer'\]\)/.test(routesPhp) &&
  routesPhp.includes("query_string($key)") &&
  routesPhp.includes("createFromFormat('!Y-m-d'") &&
  routesPhp.includes('must not be after'));
ok('API client sends the matrix event filters as an array',
  /sanctionsReport:\s*function/.test(apiJs) &&
  apiJs.includes("'/reports/sanctions'") &&
  apiJs.includes("'eventIds[]='"));
ok('matrix event filter uses an IN clause for events and attendance',
  routesPhp.includes("query_id_list('eventIds')") &&
  matrixRepo.includes(' AND id IN (') &&
  matrixRepo.includes(' AND e.id IN ('));
ok('both report pages render a grouped matrix table',
  [adminReportsHtml, sscReportsHtml].every((html) =>
    html.includes('id="sanctionMatrixHead"') &&
    html.includes('table table-bordered sanction-matrix-table') &&
    !html.includes('>Absent Events</th>')));
ok('both report pages filter the matrix by multiple events',
  [adminReportsHtml, sscReportsHtml].every((html) =>
    html.includes('id="filterEvent" multiple') &&
    html.includes('id="filterEventClear"') &&
    html.includes('id="filterEventHint"') &&
    !html.includes('id="sanctionFrom"') &&
    !html.includes('id="sanctionTo"')));
ok('both report pages expose print and CSV actions',
  adminReportsHtml.includes('id="printSanctionBtn"') &&
  adminReportsHtml.includes('id="exportSanctionCsvBtn"') &&
  sscReportsHtml.includes('id="printSanctionBtn"') &&
  sscReportsHtml.includes('id="exportSanctionCsvBtn"'));
ok('matrix styles support horizontal scrolling and landscape print',
  reportsCss.includes('.sanction-matrix-wrap') &&
  /\.sanction-matrix-wrap\s*\{[^}]*overflow-x:\s*auto/.test(reportsCss) &&
  /@page\s*\{\s*size:\s*landscape/.test(reportsCss) &&
  reportsCss.includes('.sanction-matrix-table'));
ok('matrix zebra striping uses theme-aware surfaces',
  !reportsCss.includes('--color-bg-subtle') &&
  /tbody tr:nth-child\(even\)[\s\S]*?color-bg-input/.test(reportsCss) &&
  reportsCss.includes('[data-theme="dark"] .sanction-matrix-table .matrix-check.is-present'));
ok('both report pages show a screen summary and keep the matrix for print',
  [adminReportsHtml, sscReportsHtml].every((html) =>
    html.includes('id="sanctionSummaryBody"') &&
    html.includes('id="sanctionTotalStudents"') &&
    html.includes('id="sanctionStudentsWithSanctions"') &&
    html.includes('id="sanctionTotalAbsences"') &&
    html.includes('Screen preview is summarized. Click <strong>Print Report</strong> or <strong>Export CSV</strong>') &&
    html.includes('id="sanctionMatrixView"') &&
    html.includes('sanction-matrix-view')));

/* ── 5g. Admin dashboard: sticky table header + balanced columns ── */

const adminDashboardHtml = read('student-attendance-system/pages/administrator/admin-dashboard.html');
const roleDashboardCss = read('student-attendance-system/css/role-dashboard.css');

// The events table scrolls inside the card rather than being cut by a fixed
// max-height that did not line up with the rows.
ok('admin dashboard wraps events table in a scroll container',
  adminDashboardHtml.includes('<div class="table-responsive">') &&
  /\.row\.align-items-stretch > \.col-lg-8 > \.card > \.card-body > \.table-responsive \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;/.test(roleDashboardCss));
ok('admin dashboard table container has bottom padding',
  /\.card\.shadow-sm \.card-body \.table-responsive \{[^}]*padding-bottom: 10px;/.test(roleDashboardCss));

// The table header sticks by scrolling and stays opaque over the rows.
ok('admin dashboard table header is sticky (CSS)',
  /\.table-responsive thead th \{[^}]*position: sticky;[^}]*top: 0;/.test(roleDashboardCss) &&
  roleDashboardCss.includes('background-color: var(--color-bg-card) !important;'));

// Both cards stretch to the row height so the columns stay balanced.
ok('admin dashboard both cards stretch to equal height',
  adminDashboardHtml.split('<div class="card shadow-sm h-100">').length === 3 &&
  /<div class="row g-4 mb-4 align-items-stretch">\s*<div class="col-lg-8">/.test(adminDashboardHtml));

// Quick Actions buttons sit directly under the card header instead of being
// vertically centred inside the stretched card body.
ok('admin dashboard quick actions card aligns buttons to the top',
  adminDashboardHtml.includes('<div class="card-body p-4 d-flex flex-column">') &&
  !adminDashboardHtml.includes('card-body p-4 d-flex flex-column justify-content-center'));

// The right card matches the left card's ceiling with an explicit min-height
// instead of a percentage height, which resolves to auto against an auto row.
ok('admin dashboard quick actions card has an explicit min-height floor',
  /\.row\.align-items-stretch > \.col-lg-4 > \.card \{[^}]*min-height: 510px !important;/.test(roleDashboardCss) &&
  !roleDashboardCss.includes('height: 100% !important'));

// The events card grows with its rows up to a cap, so a short list is not cut
// and a long list scrolls instead of stretching the page.
ok('admin dashboard events card caps its height and lets the list scroll',
  /\.row\.align-items-stretch > \.col-lg-8 > \.card \{[^}]*max-height: 545px;/.test(roleDashboardCss) &&
  /\.row\.align-items-stretch > \.col-lg-8 > \.card > \.card-body \{[^}]*min-height: 0;/.test(roleDashboardCss));
ok('matrix is hidden on screen and shown only for print',
  reportsCss.includes('.sanction-matrix-view { display: none; }') &&
  /@media print[\s\S]*?\.sanction-summary \{ display: none !important;/.test(reportsCss) &&
  /@media print[\s\S]*?\.sanction-matrix-view \{[\s\S]*?display: block !important;/.test(reportsCss) &&
  reportsCss.includes('.sanction-matrix-view.is-print-visible'));
ok('reports.js renders the summary and reveals the matrix around printing',
  reportsJs.includes('function renderSanctionSummary') &&
  reportsJs.includes('sanctionSummaryBody') &&
  reportsJs.includes('function setSanctionMatrixPrintVisible') &&
  /function printSanctionReport[\s\S]*?setSanctionMatrixPrintVisible\(true\)[\s\S]*?window\.print\(\)/.test(reportsJs) &&
  reportsJs.includes("addEventListener('afterprint'"));
ok('sanction CSV export uses the full event-column matrix',
  reportsJs.includes('function exportSanctionCsv') &&
  reportsJs.includes("headers.push('Total Absences', 'For Sanction')") &&
  reportsJs.includes("mark && mark.amIn ? '✓'") &&
  reportsJs.includes("mark && mark.pmOut ? '✓'") &&
  reportsJs.includes("mark && mark.attended ? '✓'"));
ok('attendance print replaces the flat table with event sections',
  reportsCss.includes('#attendanceReportTable { display: none !important; }') &&
  reportsCss.includes('.attendance-print-sections') &&
  reportsCss.includes('.report-event-section') &&
  reportsCss.includes('.report-event-table'));
ok('print layout hides non-report cards, card chrome, and inactive tabs',
  adminReportsHtml.includes('report-hide-print" aria-labelledby="correctionReviewHeading') &&
  sscReportsHtml.includes('report-hide-print" aria-labelledby="correctionReviewHeading') &&
  adminReportsHtml.includes('tab-content report-print-root') &&
  sscReportsHtml.includes('tab-content report-print-root') &&
  reportsCss.includes('.role-main > :not(.report-print-root)') &&
  reportsCss.includes('.dashboard-card > .card-heading') &&
  reportsCss.includes('.tab-pane.active * { visibility: visible !important; }'));
ok('attendance report prints department acronyms',
  reportsJs.includes('function departmentAcronym') &&
  reportsJs.includes("'School of Computer Studies': 'SCS'") &&
  reportsJs.includes("'School of Nursing': 'SON'") &&
  reportsJs.includes("'School of Business Management': 'SBM'") &&
  reportsJs.includes("departmentAcronym(rowValue(row, 'department'"));
ok('reports.js groups attendance rows per event for printing',
  reportsJs.includes('function attendanceGroups') &&
  reportsJs.includes('function renderAttendancePrintSections') &&
  reportsJs.includes('report-event-section') &&
  reportsJs.includes('report-event-id'));
ok('reports.js builds grouped major/minor matrix headers',
  reportsJs.includes('function matrixHeadHtml') &&
  reportsJs.includes("['AM In', 'AM Out', 'PM In', 'PM Out']") &&
  reportsJs.includes('matrix-major-head') &&
  reportsJs.includes('matrix-minor-head') &&
  reportsJs.includes('matrixColumnCount(events)') &&
  reportsJs.includes('function populateSanctionEventSelect'));
ok('reports.js renders and exports the matrix with a local fallback',
  reportsJs.includes('function renderSanctionReport') &&
  reportsJs.includes('function localSanctionMatrix') &&
  reportsJs.includes('function exportSanctionCsv') &&
  reportsJs.includes('sanctionReportBody') &&
  reportsJs.includes("var id = row.studentIdNumber || row.studentPublicId") &&
  reportsJs.includes("row.studentIdNumber || row.studentPublicId || ''"));
ok('seed data includes a major event with AM/PM attendance and minor flag raisings',
  seedScript.includes("'category'    => 'major'") &&
  seedScript.includes("'name'        => 'Monday Flag Raising'") &&
  seedScript.includes("'name'        => 'Wednesday Flag Raising'") &&
  seedScript.includes("'category'    => 'minor'") &&
  seedScript.includes('checkOut?->format'));

/* ── 5d. Attendance correction proof ──────────────────────────── */

const proofMigration = read('attendly-backend/db/migrations/027_correction_proof.sql');
const studentAttendanceHtml = read('student-attendance-system/pages/student/student-attendance.html');
const darkCss = read('student-attendance-system/css/dark-style.css');
const indexPhp = read('attendly-backend/public/index.php');
const configExample = read('attendly-backend/config/config.example.php');

ok('migration adds a proof_image column to correction requests',
  /ALTER TABLE attendance_correction_requests[\s\S]*ADD COLUMN proof_image MEDIUMTEXT NULL/.test(proofMigration));
ok('correction list returns hasProof without the image payload',
  repo.includes('AS has_proof') && repo.includes("'hasProof' =>") &&
  !repo.includes("'proofImage' => $row['proof_image']"));
ok('proof images are served by a dedicated owner/staff endpoint',
  routesPhp.includes("['GET', '/attendance-corrections/:id/proof'") &&
  routesPhp.includes('findAttendanceCorrectionProof') &&
  repo.includes('public function findAttendanceCorrectionProof') &&
  apiJs.includes('attendanceCorrectionProof: function') &&
  apiJs.includes("'/attendance-corrections/' + encodeURIComponent(requestId) + '/proof'"));
ok('repository validates raster data URLs before storing',
  repo.includes('private function normaliseProofImage') &&
  repo.includes('getimagesizefromstring') &&
  repo.includes("'image/jpeg', 'image/png', 'image/webp'") &&
  repo.includes('2 * 1024 * 1024'));
ok('proof length is rejected before base64 decoding',
  /strlen\(\$matches\[2\]\) > 2_800_000[\s\S]{0,200}base64_decode/.test(repo));
ok('API bodies are capped and responses are uncached',
  indexPhp.includes("header('Cache-Control: no-store')") &&
  indexPhp.includes('CONTENT_LENGTH') &&
  indexPhp.includes('payload_too_large') &&
  indexPhp.includes('4 * 1024 * 1024'));
ok('sanction event filter is capped at 200 ids',
  /count\(\$eventIds\) > 200/.test(routesPhp) && routesPhp.includes('at most 200 events'));
ok('example config enables local CORS for the documented dev setup',
  /'dev_allow_cors'\s*=>\s*true/.test(configExample));
ok('correction route requires the proof image field',
  /requireString\(\$body, 'proofImage'\)/.test(routesPhp));
ok('repository rejects a null proof image before normalising',
  /if \(\$proofImage === null\)\s*\{\s*Response::fail\('invalid_field', 'Proof of attendance is required\./.test(repo));
ok('normaliseProofImage signature is non-nullable and rejects empty strings',
  /private function normaliseProofImage\(string \$proofImage\): string/.test(repo) &&
  /if \(\$proofImage === ''\)\s*\{\s*Response::fail\('invalid_field', 'Upload a proof photo/.test(repo));
ok('review route requires an admin or ssc-officer role',
  /\['PATCH', '\/attendance-corrections\/:id\/review'[\s\S]*?requireRole\(\['admin', 'ssc-officer'\]\)/.test(routesPhp));
ok('repository review rejects a non-staff reviewer identity',
  /if \(!isset\(\$reviewer\['id'\]\)[\s\S]{0,200}Only staff may review correction requests\./.test(repo));
ok('proof endpoint returns 404 for another student proof',
  /\$viewer\['role'\] === 'student' && \$proof\['studentId'\] !== \(int\) \$viewer\['id'\]/.test(routesPhp));
ok('API client sends proofImage with the request',
  apiJs.includes('submitAttendanceCorrection: function (eventId, checkInTime, reason, proofImage)') &&
  apiJs.includes('proofImage: proofImage'));
ok('student correction form requires a proof image upload',
  studentAttendanceHtml.includes('id="correctionProof"') &&
  /id="correctionProof"[^>]*type="file"[^>]*accept="image\/jpeg,image\/png,image\/webp"[^>]*required/.test(studentAttendanceHtml) &&
  studentAttendanceHtml.includes('id="correctionProofPreview"'));
ok('student client resizes the photo and blocks a missing proof',
  studentJs.includes('function prepareProof') &&
  studentJs.includes("toDataURL('image/jpeg'") &&
  studentJs.includes('Upload a selfie or event photo as proof of attendance.'));
ok('both review tables add a Proof column and a full-size viewer modal',
  [adminReportsHtml, sscReportsHtml].every((html) =>
    html.includes('<th scope="col">Proof</th>') &&
    html.includes('id="correctionProofModal"') &&
    html.includes('id="correctionProofModalImage"') &&
    html.includes('colspan="7"')));
ok('staff and student clients open the shared on-demand proof viewer',
  adminJs.includes('data-proof-id') && adminJs.includes('function showProof') &&
  sscJs.includes('data-proof-id') && sscJs.includes('function showProof') &&
  adminJs.includes('openAttendanceProof(') && sscJs.includes('openAttendanceProof(') &&
  studentJs.includes('data-proof-id') && studentJs.includes('openAttendanceProof(') &&
  uiJs.includes('async function openAttendanceProof') &&
  uiJs.includes('api.attendanceCorrectionProof(requestId)') &&
  uiJs.includes('data:image\\/'));
ok('all three tables branch on hasProof',
  adminJs.includes('request.hasProof') && sscJs.includes('request.hasProof') &&
  studentJs.includes('request.hasProof'));
ok('proof viewer shows a loading state on every page that opens it',
  [adminReportsHtml, sscReportsHtml, studentAttendanceHtml].every((html) =>
    html.includes('id="correctionProofModal"') &&
    html.includes('id="correctionProofLoading"') &&
    html.includes('id="correctionProofError"') &&
    html.includes('Loading proof…')) &&
  studentAttendanceHtml.includes('<th scope="col">Proof</th>'));
ok('dark theme repaints native picker glyphs for visibility',
  darkCss.includes('color-scheme: dark') &&
  darkCss.includes("stroke='%2397ad9f'") &&
  darkCss.includes('input[type="datetime-local"]'));

/* ── 5e. Deny-request modal and final consistency pass ──────────── */

const frontendRefreshCss = read('student-attendance-system/css/frontend-refresh.css');

ok('correction denial no longer uses the native prompt',
  !adminJs.includes("window.prompt('Enter a reason for denying this correction request:')") &&
  !sscJs.includes("window.prompt('Enter a reason for denying this correction request:')"));
ok('both report pages include the deny-reason modal',
  [adminReportsHtml, sscReportsHtml].every((html) =>
    html.includes('id="denyRequestModal"') &&
    html.includes('id="denyReasonInput"') &&
    html.includes('id="denyRequestConfirm"') &&
    html.includes('placeholder="State the reason for denial..."') &&
    html.includes('data-bs-dismiss="modal"')));
ok('staff clients open the modal and submit the typed denial reason',
  adminJs.includes('function openDenyModal') && sscJs.includes('function openDenyModal') &&
  adminJs.includes("api.reviewAttendanceCorrection(pendingDenyId, 'denied', notes)") &&
  sscJs.includes("api.reviewAttendanceCorrection(pendingDenyId, 'denied', notes)") &&
  adminJs.includes('Enter a reason before denying this request.') &&
  sscJs.includes('Enter a reason before denying this request.'));
ok('correction review actions use a shared aligned wrapper',
  [adminJs, sscJs].every((js) => js.includes('class="table-actions"')) &&
  [adminReportsHtml, sscReportsHtml].every((html) => html.includes('correction-review-table')));
ok('final consistency CSS unifies motion, cards, headers, and titles',
  frontendRefreshCss.includes('.2s ease-in-out') &&
  /:is\(\.role-card, \.dashboard-card, \.dash-panel, \.activity-panel, \.stat-card, \.settings-card, \.card\)\s*\{\s*border-radius:\s*var\(--radius-card\);/.test(frontendRefreshCss) &&
  frontendRefreshCss.includes('.table:not(.sanction-matrix-table) thead th') &&
  frontendRefreshCss.includes('.correction-review-table .table-actions .btn') &&
  frontendRefreshCss.includes('text-transform: uppercase;') &&
  frontendRefreshCss.includes('font-weight: 700;'));

/* ── 5f. Appeal feature removed end-to-end ─────────────────────── */

ok('migration drops the appeals table', /DROP TABLE IF EXISTS student_appeals/.test(dropAppeals));
ok('repository no longer mentions appeals', !repo.includes('student_appeals'));
ok('appeal routes removed', !routesPhp.includes('/appeals'));
ok('API client no longer exposes appeals', !apiJs.includes('listAppeals') && !apiJs.includes('submitAppeal'));
ok('storage no longer exposes appeal accessors', !dataJs.includes('getAppeals') && !dataJs.includes('setAppeals'));
ok('student sanctions page has no appeal UI', !read('student-attendance-system/pages/student/student-sanctions.html').includes('appeal'));

const frontController = read('attendly-backend/public/index.php');
const corsGateAt = frontController.indexOf("if (($config['cors']['dev_allow_cors'] ?? false) === true) {");
const routeTableAt = frontController.indexOf('// ── Route table');
const corsHeaderCount = (frontController.match(/Access-Control-/g) || []).length;
const gatedCorsHeaderCount = corsGateAt === -1 || routeTableAt === -1
  ? 0
  : (frontController.slice(corsGateAt, routeTableAt).match(/Access-Control-/g) || []).length;
const gatedCorsBlock = corsGateAt === -1 || routeTableAt === -1
  ? ''
  : frontController.slice(corsGateAt, routeTableAt);

ok('front controller gates CORS on dev_allow_cors', corsGateAt !== -1 && routeTableAt > corsGateAt);
ok('CORS requires dev_allow_cors to be boolean true', /dev_allow_cors'\] \?\? false\) === true/.test(frontController));
ok('all CORS headers live inside the dev gate', corsHeaderCount > 0 && corsHeaderCount === gatedCorsHeaderCount, `${gatedCorsHeaderCount}/${corsHeaderCount}`);
ok('CORS preflight handling is inside the dev gate', /http_response_code\(204\);\s*exit;/.test(gatedCorsBlock));
ok('example config enables CORS for the documented local dev setup', /'dev_allow_cors'\s*=>\s*true/.test(read('attendly-backend/config/config.example.php')));

/* ── 5e. Shared role sidebar (admin + SSC + student) ────────────── */

const adminNavPages = [
  'student-attendance-system/pages/administrator/admin-dashboard.html',
  'student-attendance-system/pages/administrator/admin-manage-officers.html',
  'student-attendance-system/pages/administrator/admin-manage-students.html',
  'student-attendance-system/pages/administrator/admin-reports.html',
  'student-attendance-system/pages/administrator/admin-settings.html',
];
const sscNavPages = [
  'student-attendance-system/pages/ssc-officer/ssc-dashboard.html',
  'student-attendance-system/pages/ssc-officer/ssc-manage-events.html',
  'student-attendance-system/pages/ssc-officer/ssc-manage-students.html',
  'student-attendance-system/pages/ssc-officer/ssc-reports.html',
];
const studentNavPages = [
  'student-attendance-system/pages/student/student-dashboard.html',
  'student-attendance-system/pages/student/student-attendance.html',
  'student-attendance-system/pages/student/student-profile.html',
  'student-attendance-system/pages/student/student-sanctions.html',
];
const roleNavPages = [...adminNavPages, ...sscNavPages, ...studentNavPages];
const roleNavHtml = roleNavPages.map((page) => read(page));
const navBlockOf = (html) => (html.match(/<nav class="role-nav"[^>]*>([\s\S]*?)<\/nav>/) || [])[1] || '';
const footerBlockOf = (html) => (html.match(/<div class="role-sidebar-footer">([\s\S]*?)<\/div>/) || [])[1] || '';
const activeNavLinksOf = (html) =>
  (navBlockOf(html).match(/<a[^>]*class="[^"]*\bactive\b[^"]*"[^>]*>/g) || []);

ok('every role page uses the shared sidebar shell',
  roleNavHtml.every((html) =>
    html.includes('<aside class="role-sidebar">') &&
    html.includes('<a class="role-brand"') &&
    html.includes('class="role-profile"') &&
    html.includes('class="role-nav"') &&
    html.includes('class="role-sidebar-footer"')) &&
  roleNavHtml.every((html) =>
    !html.includes('student-sidebar') &&
    !html.includes('student-nav') &&
    !html.includes('student-brand') &&
    !html.includes('brand-chip')));
ok('every role page has one active navigation item with aria-current',
  roleNavHtml.every((html) => {
    const active = activeNavLinksOf(html);
    return active.length === 1 && active[0].includes('aria-current="page"');
  }));
ok('every role sidebar footer is the single Log out action',
  roleNavHtml.every((html) => {
    const footer = footerBlockOf(html);
    return footer.includes('role-sidebar-action logout-action') &&
      !footer.includes('bi-gear') &&
      (footer.match(/<button/g) || []).length === 1;
  }));
ok('admin reports and student profile expose their active nav item',
  activeNavLinksOf(read(adminNavPages[3]))[0].includes('admin-reports.html') &&
  activeNavLinksOf(read(studentNavPages[2]))[0].includes('student-profile.html'));
ok('student nav uses the shared role classes and links to My profile',
  roleNavHtml.slice(-studentNavPages.length).every((html) =>
    navBlockOf(html).includes('student-profile.html') &&
    navBlockOf(html).includes('My attendance') &&
    navBlockOf(html).includes('Sanctions')));
ok('student sidebar styles are not duplicated in student-dashboard.css',
  !read('student-attendance-system/css/student-dashboard.css').includes('.student-sidebar') &&
  !read('student-attendance-system/css/student-dashboard.css').includes('.student-nav') &&
  !read('student-attendance-system/css/student-dashboard.css').includes('.student-brand') &&
  !read('student-attendance-system/css/student-dashboard.css').includes('.student-profile'));
ok('student profile starts read-only with an Edit Info / Cancel flow',
  (() => {
    const html = read('student-attendance-system/pages/student/student-profile.html');
    const email = html.match(/<input[^>]*id="profileEmail"[^>]*>/);
    const contact = html.match(/<input[^>]*id="profileContact"[^>]*>/);
    return !!(
      email && /\breadonly\b/.test(email[0]) &&
      contact && /\breadonly\b/.test(contact[0]) &&
      html.includes('id="saveProfileBtnLabel">Edit Info<') &&
      html.includes('id="cancelProfileEditBtn"') &&
      html.includes('profile-readonly-panel')
    );
  })());

/* ── Report ─────────────────────────────────────────────────────── */

if (failures.length === 0) {
  console.log(`  ${pass} contract assertions passed`);
  process.exit(0);
}
console.log(`  ${pass} passed, ${failures.length} FAILED:`);
for (const f of failures) console.log('    - ' + f);
process.exit(1);

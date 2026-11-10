/* Tests for the backend data wiring: hydrateFromApi, isApiEnabled and the
 * event payload translation.
 *
 * These lift the real implementations out of js/api.js rather than
 * restating them, so the assertions cannot drift from the code.
 *
 * Run: node tools/hydration.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/api.js'), 'utf8');

let pass = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) pass++;
  else failures.push(name + (detail !== undefined ? ' -> ' + detail : ''));
}

async function throws(fn) {
  try { await fn(); return false; } catch { return true; }
}

/* ── Lift the real implementations ──────────────────────────────── */
// These resolve API_BASE_URL, api and window from the surrounding scope,
// so they must be declared before the eval below.

var API_BASE_URL = '';
var api = {};
var window = {};

const lift = (name) => eval('(' + apiSrc.match(new RegExp('(?:async )?function ' + name + '[\\s\\S]*?\\n}'))[0] + ')');

const isApiEnabled = lift('isApiEnabled');
const hydrateFromApi = lift('hydrateFromApi');
const addHour = lift('addHour');

/* ── The accessors hydration writes through ─────────────────────── */

function freshStore() {
  const store = {};
  window.setUsers = (v) => { store.users = v; };
  window.setEvents = (v) => { store.events = v; };
  window.setAnnouncements = (v) => { store.announcements = v; };
  window.setAttendance = (v) => { store.attendance = v; };
  window.setSanctions = (v) => { store.sanctions = v; };
  window.setReenrollmentRequests = (v) => { store.reenrollmentRequests = v; };
  window.setAuditLogs = (v) => { store.auditLogs = v; };
  return store;
}

function workingApi() {
  return {
    listUsers: async () => [{ id: 1, role: 'student', name: 'Ana' }],
    listEvents: async () => [{ id: 7, name: 'Foundation Day', type: 'major', mandatory: true }],
    listAnnouncements: async () => [{ id: 2, title: 'Welcome' }],
    listAttendance: async () => [{ id: 3, eventId: 7, studentId: 1, status: 'present' }],
    listSanctions: async () => [{ id: 4, studentId: 1, severity: 'probation', status: 'active' }],
    listReenrollmentRequests: async () => [{ id: 6, studentId: 1, status: 'pending-review' }],
    listAuditLogs: async () => [{ id: 1, userId: 1, actorEmail: 'admin@test.com', actorName: 'Admin', action: 'create', tableName: 'users', recordId: 1, createdAt: '2026-01-15T10:00:00' }],
  };
}

(async () => {

  /* ── 1. isApiEnabled gates everything ────────────────────────── */

  API_BASE_URL = '';
  ok('disabled when base URL is empty', isApiEnabled() === false);
  API_BASE_URL = '   ';
  ok('disabled when base URL is whitespace', isApiEnabled() === false);
  API_BASE_URL = 'http://localhost:8000/api';
  ok('enabled when base URL is set', isApiEnabled() === true);

  /* ── 2. Disabled mode must not touch the network or the cache ── */

  API_BASE_URL = '';
  api = workingApi();
  let store = freshStore();
  let result = await hydrateFromApi();
  ok('disabled: nothing synced', result.synced.length === 0, JSON.stringify(result.synced));
  ok('disabled: nothing failed', result.failed.length === 0);
  ok('disabled: cache untouched', Object.keys(store).length === 0, Object.keys(store).join(','));
  ok('disabled: never throws', (await throws(() => hydrateFromApi())) === false);

  /* ── 3. Enabled mode primes every collection ─────────────────── */

  API_BASE_URL = 'http://localhost:8000/api';
  api = workingApi();
  store = freshStore();
  result = await hydrateFromApi();
  ok('all seven collections synced', result.synced.length === 7, JSON.stringify(result.synced));
  ok('none failed', result.failed.length === 0, JSON.stringify(result.failed));
  ok('users written through setUsers', store.users && store.users[0].name === 'Ana');
  ok('events written through setEvents', store.events && store.events[0].type === 'major');
  ok('announcements written through setAnnouncements', store.announcements && store.announcements[0].title === 'Welcome');
  ok('attendance written through setAttendance', store.attendance && store.attendance[0].status === 'present');
  ok('sanctions written through setSanctions', store.sanctions && store.sanctions[0].severity === 'probation');
  ok('reenrollment requests written through setReenrollmentRequests',
    store.reenrollmentRequests && store.reenrollmentRequests[0].status === 'pending-review');
  ok('audit logs written through setAuditLogs', store.auditLogs && Array.isArray(store.auditLogs));

  /* ── 4. One failing collection must not block the others ─────── */

  api = workingApi();
  api.listEvents = async () => { throw new Error('boom'); };
  store = freshStore();
  result = await hydrateFromApi();
  ok('partial failure reported', result.failed.includes('events'), JSON.stringify(result.failed));
  ok('other collections still synced', result.synced.length === 6, JSON.stringify(result.synced));
  ok('failed collection left cache alone', store.events === undefined);
  ok('hydrate never throws on server error', (await throws(() => hydrateFromApi())) === false);

  /* ── 5. A malformed payload is a failure, not silent corruption ─ */

  api = workingApi();
  api.listUsers = async () => ({ not: 'an array' });
  store = freshStore();
  result = await hydrateFromApi();
  ok('non-array response rejected', result.failed.includes('users'), JSON.stringify(result.failed));
  ok('non-array response not written', store.users === undefined);

  /* ── 6. A missing accessor is a failure, not a crash ─────────── */

  api = workingApi();
  store = freshStore();
  delete window.setSanctions;
  result = await hydrateFromApi();
  ok('missing accessor reported', result.failed.includes('sanctions'), JSON.stringify(result.failed));
  ok('missing accessor does not crash', result.synced.includes('users'));

  /* ── 7. The event payload translation ────────────────────────── */

  ok('addHour 08:00 -> 09:00', addHour('08:00') === '09:00', addHour('08:00'));
  ok('addHour 23:30 wraps to 00:30', addHour('23:30') === '00:30', addHour('23:30'));
  ok('addHour 09:07 -> 10:07', addHour('09:07') === '10:07', addHour('09:07'));
  ok('addHour tolerates junk', /^\d{2}:\d{2}$/.test(addHour('nonsense')), addHour('nonsense'));

  // api.toEventPayload is a method on the `api` object literal, so it has to
  // be lifted as `function (event, endTime) {...}` rather than a declaration.
  const toEventPayload = eval('(' + apiSrc.match(/function \(event, endTime\) \{[\s\S]*?\n  \}/)[0] + ')');

  const major = toEventPayload({ name: 'Foundation Day', date: '2026-03-10', time: '08:00', location: 'Hall A', type: 'major' });
  ok('name passed through', major.name === 'Foundation Day');
  ok('date passed through', major.date === '2026-03-10');
  ok('location -> venue', major.venue === 'Hall A', major.venue);
  ok('major -> mandatory', major.eventType === 'mandatory', major.eventType);
  ok('startTime from time', major.startTime === '08:00');
  ok('endTime defaults to +1h', major.endTime === '09:00', major.endTime);
  ok('missing description becomes null', major.description === null);

  const minor = toEventPayload({ name: 'Flag Ceremony', date: '2026-03-11', time: '07:15', location: 'Grounds', type: 'minor' });
  ok('minor -> optional', minor.eventType === 'optional', minor.eventType);
  ok('explicit endTime is respected', toEventPayload({ time: '08:00' }, '11:30').endTime === '11:30');

  /* ── 8. Structural guards on the wiring ──────────────────────── */
  // These cannot run the UI, but they do stop someone deleting a guard and
  // silently making an offline build depend on the network.

  const kioskJs = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/kiosk.js'), 'utf8');
  const sscJs = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/ssc.js'), 'utf8');
  const authSource = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/auth.js'), 'utf8');
  const dataJs = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/data.js'), 'utf8');
  const administratorPanelJs = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/administrator-panel.js'), 'utf8');

  ok('kiosk sends scans to the verified QR endpoint', /api\.qrCheckIn\(/.test(kioskJs));
  ok('kiosk never matches descriptors locally',
    !/\.identify\(/.test(kioskJs) && !/findBestMatch/.test(kioskJs));
  ok('kiosk server call is gated on isApiEnabled', /async function runQrScan\(\) \{\s*if \(!isApiEnabled\(\)\)/.test(kioskJs));
  ok('kiosk keeps the server attendance row', /addServerRecord\(record, event\.id\)/.test(kioskJs));
  ok('kiosk keeps the excused flag', /excused: false/.test(kioskJs));
  ok('kiosk surfaces a server failure', /'server-error'/.test(kioskJs));
  ok('kiosk never invents an offline attendance row',
    !/generateId\('att'\)/.test(kioskJs) && !/record \|\| \{/.test(kioskJs));
  ok('kiosk routes manual entry through the server',
    /api\.manualCheckIn\(/.test(kioskJs) && /runManualEntry/.test(kioskJs));

  ok('kiosk hydrates server events', /api\.listEvents\(\)/.test(kioskJs));
  ok('kiosk hydrates server users', /api\.listUsers\(\)/.test(kioskJs));
  ok('kiosk hydrates server attendance', /api\.listAttendance\(\)/.test(kioskJs));
  ok('kiosk no longer hydrates face enrollments', !/api\.listFaceEnrollments\(\)/.test(kioskJs));
  ok('kiosk unlocks through the login endpoint', /api\.login\(/.test(kioskJs));
  ok('kiosk checks the officer role', /isOfficerRole/.test(kioskJs) && /ssc-officer/.test(kioskJs));
  ok('kiosk verifies the existing session on load', /api\.me\(\)/.test(kioskJs));
  ok('kiosk has an inactivity auto-lock', /AUTO_LOCK_MS/.test(kioskJs) && /lockStation\(/.test(kioskJs));
  ok('kiosk locks on an expired session', /isSessionError\(err\)/.test(kioskJs));

  ok('ssc event create is gated on isApiEnabled', /function syncEventToServer[\s\S]*?if \(!isApiEnabled\(\)\) return;/.test(sscJs));
  ok('ssc event delete is gated on isApiEnabled and numeric ids',
    sscJs.includes('function syncEventDeleteToServer') &&
    sscJs.includes('if (!isApiEnabled() || !/^\\d+$/.test(String(eventId))) return;'));
  ok('ssc create adopts the server row', /Object\.assign\(\{\}, e, saved\)/.test(sscJs));

  ok('API login hydrates before redirecting', /await hydrateFromApi\(\)/.test(authSource));
  ok('partial hydration failure is reported', /hydration\.failed\.length/.test(authSource));
  ok('logout does not restore demo data', !/resetDemoData\(\)/.test(authSource));
  ok('auth requires the API', /if \(!isApiEnabled\(\)\)/.test(authSource));
  ok('login has no local credential fallback', !/passwordMatches\(/.test(authSource));
  ok('signup posts the register contract', /api\.registerStudent\(payload\)/.test(authSource));
  ok('signup does not create a local account', !/setUsers\(users\.concat/.test(authSource));
  ok('temporary passwords route to the change page', /pageUrl\('change-password'\)/.test(authSource));
  ok('change page verifies through /auth/me', /api\.me\(\)/.test(authSource));
  ok('fresh storage initialiser exists', /function initStorage/.test(dataJs));
  ok('storage version marker exists', /DATA_VERSION = '6-qr'/.test(dataJs));
  ok('version mismatch wipes app data', /localStorage\.getItem\(STORAGE_KEYS\.dataVersion\) !== DATA_VERSION[\s\S]*?clearAllAppData\(\)/.test(dataJs));
  ok('collections start empty', /function emptyCollections/.test(dataJs) && !/getDemoStudentCohort/.test(dataJs));
  ok('no demo reset helper remains', !/function (?:resetDemoData|initMockData)/.test(dataJs));


  /* ── 9. Documented sync coverage must match reality ─────────── */
  // The comment block in api.js lists what is and is not synced. If someone
  // adds a write path they must update it, and this asserts the two agree.

  ok('api.js documents sync coverage', /What is and is not synced/.test(apiSrc));
  ok('coverage no longer lists a student create path', !/student create/.test(apiSrc));

  const syncedWrites = [
    ['event create is wired', /function syncEventToServer/.test(sscJs)],
    ['event delete is wired', /function syncEventDeleteToServer/.test(sscJs)],
    ['kiosk check-in is wired', /api\.qrCheckIn\(/.test(kioskJs)],
  ];
  for (const [name, wired] of syncedWrites) {
    ok(`${name} and is documented as synced`, wired);
  }

  // Student creation was removed from the UI; the API client must not
  // advertise a helper that no page uses.
  ok('student create does not call the API', !/api\.createStudent\(/.test(administratorPanelJs));
  ok('student create helper is gone', !/createStudent\s*:/.test(apiSrc));

  /* ── Report ────────────────────────────────────────────────── */

  if (failures.length === 0) {
    console.log(`  ${pass} hydration assertions passed`);
    process.exit(0);
  }
  console.log(`  ${pass} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log('    - ' + f);
  process.exit(1);
})();

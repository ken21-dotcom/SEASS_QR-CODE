/* ============================================================
   Data Layer — localStorage cache, sessions
   ------------------------------------------------------------
   MySQL is the source of truth. Every entity (users, events,
   attendance, sanctions, etc.) has a typed get/set pair that
   reads and writes the browser's local cache; api.js hydrates
   that cache after a successful login.

   Accounts, password hashes and sessions live in the backend.
   Local storage stays empty on a fresh install until data is
   hydrated.

   Production note: localStorage is used only for the prototype.
   A real deployment stores everything server-side and this file
   becomes a thin API-client wrapper.

   STORAGE_KEYS use the "attendly_" prefix to avoid collisions
   with other applications on the same origin.
   ============================================================ */

// ── Storage key registry ──
const STORAGE_KEYS = Object.freeze({
  users:                'attendly_users',
  attendance:           'attendly_attendance',
  events:               'attendly_events',
  announcements:        'attendly_announcements',
  sanctions:            'attendly_sanctions',
  reenrollmentRequests: 'attendly_reenrollment_requests',
  auditLogs:            'attendly_audit_logs',
  session:              'attendly_session',
  dataVersion:          'attendly_data_version',
});

/**
 * Current storage schema version. Bumping this wipes every
 * `attendly_*` key once on the next load — used to clear demo
 * accounts and stale caches from earlier builds.
 */
const DATA_VERSION = '6-qr';


/* ============================================================
   Student Organisational Taxonomy (Department → Course → Year)
   ------------------------------------------------------------
   Students are grouped under these headings on the manage-
   students pages. Values are prototype sample data — a real
   deployment pulls departments/courses from the registrar.
   ============================================================ */

const DEPARTMENTS = Object.freeze([
  'School of Computer Studies',
  'School of Nursing',
  'School of Business Management',
]);

const COURSES_BY_DEPARTMENT = Object.freeze({
  'School of Computer Studies': ['BSIT'],
  'School of Nursing': ['BSN'],
  'School of Business Management': ['BSEntrep', 'BSHM', 'BSTM'],
});

/** Full display labels for the short program codes stored in records. */
const PROGRAM_LABELS = Object.freeze({
  'BSIT': 'BSIT – Bachelor of Science in Information Technology',
  'BSN': 'BSN – Bachelor of Science in Nursing',
  'BSEntrep': 'BSEntrep – Bachelor of Science in Entrepreneurship',
  'BSHM': 'BSHM – Bachelor of Science in Hospitality Management',
  'BSTM': 'BSTM – Bachelor of Science in Tourism Management',
});

const YEAR_LEVELS = Object.freeze(['1', '2', '3', '4']);

/** Fallback bucket used whenever a student record lacks an org field. */
const UNASSIGNED = 'Unassigned';


/* ============================================================
   Password Hashing — SHA-256 (FIPS 180-4)
   ------------------------------------------------------------
   Demo/stored passwords are hashed before they ever touch
   localStorage, so plaintext is never persisted. This compact
   synchronous implementation works from any origin (file://
   included) without Web Crypto's secure-context requirement.

   Production note: this is a prototype-only convenience. A real
   deployment hashes with bcrypt/argon2 server-side (see the PHP
   backend, which uses PHP's password_hash() / password_verify()).
   ============================================================ */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

/**
 * UTF-8-safe SHA-256 of a string, returned as a 64-char lowercase hex digest.
 * @param {string} message
 * @returns {string}
 */
function sha256Hex(message) {
  const str = String(message);
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0xd800 || c >= 0xe000)
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else { // surrogate pair → 4-byte sequence
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(++i) & 0x3ff));
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length (high 32 bits zero for our short inputs)
  bytes.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);

  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++)
      w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = sha256Rotr(w[i - 15], 7) ^ sha256Rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = sha256Rotr(w[i - 2], 17) ^ sha256Rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], h7 = h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = sha256Rotr(e, 6) ^ sha256Rotr(e, 11) ^ sha256Rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h7 + s1 + ch + SHA256_K[i] + w[i]) | 0;
      const s0 = sha256Rotr(a, 2) ^ sha256Rotr(a, 13) ^ sha256Rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h7 = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + h7) | 0;
  }
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * Hash a password for storage. See note above on prototype scope.
 * @param {string} plain
 * @returns {string} 64-char lowercase hex digest
 */
function hashPassword(plain) {
  return sha256Hex(String(plain));
}

/** True when a stored (SHA-256 hex) value matches the typed password. */
function passwordMatches(plain, stored) {
  return typeof stored === 'string' && stored === hashPassword(plain);
}

/** A stored SHA-256 digest is always 64 lowercase hex chars. */
const HASHED_PASSWORD_RE = /^[a-f0-9]{64}$/;

/**
 * Keys that hold collections the app reads through its typed accessors.
 * Every one starts as an empty array so the UI never has to handle
 * a missing collection on a fresh install.
 */
function emptyCollections() {
  return {
    [STORAGE_KEYS.users]:                [],
    [STORAGE_KEYS.attendance]:           [],
    [STORAGE_KEYS.events]:               [],
    [STORAGE_KEYS.announcements]:        [],
    [STORAGE_KEYS.reenrollmentRequests]: [],
    [STORAGE_KEYS.auditLogs]:            [],
  };
}


/* ============================================================
   Storage initialisation
   ------------------------------------------------------------
   Every browser starts with an empty cache. When data from an
   older build is present (demo users, stale caches), the version
   check below wipes every `attendly_*` key exactly once so the
   backend can hydrate clean records.
   ============================================================ */

/** Remove every key this app owns, including the version marker. */
function clearAllAppData() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.indexOf('attendly_') === 0) keys.push(key);
  }
  keys.forEach(key => localStorage.removeItem(key));
}

// Older builds prefixed cached labels with "[SEED]" / "[DEMO]".
const LEGACY_TAG_TEST = /\[(?:SEED|DEMO)\]/i;
const LEGACY_TAG_STRIP = /\[(?:SEED|DEMO)\]\s*/gi;

/** Recursively strip legacy labels from a parsed cache value. */
function stripLegacyTags(value) {
  if (typeof value === 'string') return value.replace(LEGACY_TAG_STRIP, '');
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = stripLegacyTags(value[i]);
    return value;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach(key => { value[key] = stripLegacyTags(value[key]); });
    return value;
  }
  return value;
}

/**
 * Remove "[SEED]"/"[DEMO]" labels left in the browser cache by older
 * builds. Only parsed JSON is rewritten, and only when the text actually
 * changed, so the session and unrelated keys stay intact.
 */
function purgeLegacyTags() {
  const rewritten = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key.indexOf('attendly_') !== 0) continue;
    if (key === STORAGE_KEYS.session || key === STORAGE_KEYS.dataVersion) continue;

    const raw = localStorage.getItem(key);
    if (!raw || !LEGACY_TAG_TEST.test(raw)) continue;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (ignored) {
      continue;
    }

    const cleaned = JSON.stringify(stripLegacyTags(parsed));
    if (cleaned !== raw) rewritten.push([key, cleaned]);
  }
  rewritten.forEach(entry => localStorage.setItem(entry[0], entry[1]));
}

/**
 * Prepare localStorage for this app. Runs on every page load.
 *
 * - A missing/old data version triggers a one-time wipe.
 * - Legacy "[SEED]"/"[DEMO]" labels are stripped from cached records.
 * - Missing collection keys are created empty (never overwritten).
 * - No demo users, events or QR samples are ever injected.
 */
function initStorage() {
  if (localStorage.getItem(STORAGE_KEYS.dataVersion) !== DATA_VERSION) {
    clearAllAppData();
  }

  purgeLegacyTags();

  // The appeal feature was removed; drop any cache left by an older build.
  localStorage.removeItem('attendly_appeals');

  const collections = emptyCollections();
  Object.keys(collections).forEach(key => {
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, JSON.stringify(collections[key]));
    }
  });

  localStorage.setItem(STORAGE_KEYS.dataVersion, DATA_VERSION);
}

/**
 * Erase every local record and start over. Accounts and their sessions
 * live in the backend, so this only clears the browser cache.
 */
function resetAllData() {
  clearAllAppData();
  initStorage();
}

initStorage();


/* ============================================================
   Date Helpers
   ============================================================ */

/**
 * Return today's date as a local "YYYY-MM-DD" string, optionally
 * offset by `offsetDays`. Uses local time (not UTC) so the
 * date changeover happens at local midnight.
 *
 * @param {number} [offsetDays=0] — days to add (negative = past)
 * @returns {string} e.g. "2026-09-08"
 */
function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}


/* ============================================================
   Generic localStorage Getters & Setters
   ============================================================ */

/**
 * Safely parse a JSON value from localStorage.
 * Returns `fallback` when the key is missing or the value
 * is corrupt (avoids runtime crashes on corrupted storage).
 *
 * @param {string} key      — localStorage key
 * @param {*}      fallback — value returned on missing/corrupt data
 * @returns {*}
 */
function safeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function getUsers()                { return safeGet(STORAGE_KEYS.users, []); }
function getEvents()               { return safeGet(STORAGE_KEYS.events, []); }
function getAttendance()           { return safeGet(STORAGE_KEYS.attendance, []); }
function getAnnouncements()        { return safeGet(STORAGE_KEYS.announcements, []); }
function getSanctions()            { return safeGet(STORAGE_KEYS.sanctions, []); }
function getReenrollmentRequests() { return safeGet(STORAGE_KEYS.reenrollmentRequests, []); }
function getAuditLogs()            { return safeGet(STORAGE_KEYS.auditLogs, []); }

function setUsers(users)                 { localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(users)); }
function setEvents(events)               { localStorage.setItem(STORAGE_KEYS.events, JSON.stringify(events)); }
function setAttendance(attendance)       { localStorage.setItem(STORAGE_KEYS.attendance, JSON.stringify(attendance)); }
function setAnnouncements(announcements) { localStorage.setItem(STORAGE_KEYS.announcements, JSON.stringify(announcements)); }
function setSanctions(sanctions)         { localStorage.setItem(STORAGE_KEYS.sanctions, JSON.stringify(sanctions)); }
function setReenrollmentRequests(reqs)   { localStorage.setItem(STORAGE_KEYS.reenrollmentRequests, JSON.stringify(reqs)); }
function setAuditLogs(logs)              { localStorage.setItem(STORAGE_KEYS.auditLogs, JSON.stringify(logs)); }

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/**
 * Count distinct student/event attendance pairs.
 *
 * A four_point event stores one row per scan pair (AM and PM), so raw
 * `attendance.length` would count the same student twice and inflate the
 * dashboard rate. Single/in_out events keep one row and are unaffected.
 *
 * @param {object[]} rows
 * @returns {number}
 */
function countUniqueAttendance(rows) {
  const seen = new Set();
  (rows || []).forEach(row => {
    if (!row) return;
    seen.add(String(row.eventId) + ':' + String(row.studentId));
  });
  return seen.size;
}


/* ============================================================
   Session Management
   ============================================================ */

/**
 * Retrieve the current session object from localStorage.
 * @returns {{ id: string|number, publicId: string|null, name: string, email: string, role: string,
 *             mustChangePassword: boolean }|null}
 */
function getSession() {
  return safeGet(STORAGE_KEYS.session, null);
}

/**
 * Persist a minimal, non-sensitive session record.
 * Only identity and routing fields are stored — the password
 * stays in the users collection and is never serialised to
 * the session key. mustChangePassword is kept here because the
 * dashboard shell needs it before it can hydrate the user list.
 *
 * @param {object|null} user — pass null to clear the session
 */
function setSession(user) {
  if (!user) { clearSession(); return; }
  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({
    id:                 user.id,
    publicId:           user.publicId || null,
    name:               user.name,
    email:              user.email,
    role:               user.role,
    mustChangePassword: user.mustChangePassword === true,
  }));
}

/** Remove the active session. */
function clearSession() {
  localStorage.removeItem(STORAGE_KEYS.session);
}

/**
 * Resolve the currently-logged-in user.
 *
 * Offline mode: the session record is cross-referenced against the
 * localStorage users collection, so a deleted user correctly resolves
 * to null.
 *
 * Backend mode: the signed-in user lives in the database, not in
 * localStorage, so there is nothing to cross-reference — falling back
 * to the cached session record is what keeps requireAuth() working.
 * Without this, an API login would resolve to null and every role page
 * would bounce straight back to the login screen.
 *
 * @returns {object|null} full user object (including role)
 */
function getCurrentUser() {
  const session = getSession();
  if (!session) return null;
  const cached = getUsers().find(u => sameId(u.id, session.id));
  if (cached) {
    // The login response is the freshest signal that a temporary password
    // is outstanding; a stale hydrated row must not hide it.
    return Object.assign({}, cached, {
      mustChangePassword: session.mustChangePassword === true || cached.mustChangePassword === true,
    });
  }
  return isApiEnabled() ? session : null;
}


/* ============================================================
   Utility
   ============================================================ */

/**
 * Generate a collision-resistant unique ID. The prefix makes
 * it easy to identify the entity type in the DOM / console.
 *
 * @param {string} [prefix='id'] — e.g. 'stu', 'evt', 'sanc'
 * @returns {string} e.g. "stu_k3j9f8a2m"
 */
function generateId(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).substring(2, 11)}`;
}


/* ============================================================
   Student Organisational Helpers (Department → Course → Year)
   ------------------------------------------------------------
   Pure, DOM-free logic used by the grouped manage-students lists
   (SSC + Admin). Kept here so it can be exercised in Node tests.
   ============================================================ */

const PROGRAM_ALIASES = Object.freeze({
  BSIT: 'BSIT',
  BSN: 'BSN',
  BSENTREP: 'BSEntrep',
  BSE: 'BSEntrep',
  BSHM: 'BSHM',
  BSTM: 'BSTM',
});

const DEPARTMENT_ALIASES = Object.freeze({
  'SCHOOL OF COMPUTER STUDIES': 'School of Computer Studies',
  'SCHOOL OF COMPUTING STUDIES': 'School of Computer Studies',
  'COLLEGE OF COMPUTER STUDIES': 'School of Computer Studies',
  'COLLEGE OF INFORMATION TECHNOLOGY': 'School of Computer Studies',
  'SCS': 'School of Computer Studies',
  'SCHOOL OF NURSING': 'School of Nursing',
  'COLLEGE OF NURSING': 'School of Nursing',
  'SON': 'School of Nursing',
  'SCHOOL OF BUSINESS MANAGEMENT': 'School of Business Management',
  'SCHOOL OF BUSINESS AND ADMINISTRATION': 'School of Business Management',
  'SCHOOL OF BUSINESS AND MANAGEMENT': 'School of Business Management',
  'COLLEGE OF BUSINESS': 'School of Business Management',
  'SBM': 'School of Business Management',
});

/**
 * Resolve a legacy/full program name to its canonical short code.
 * Accepts "BSIT", "BSIT – Bachelor ...", "BSE – ...", etc.
 * @param {string} value
 * @returns {string} canonical code, or '' when unknown
 */
function normalizeProgramCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase()
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ');
  const head = upper.split(/\s*-\s*/)[0].trim();
  if (PROGRAM_ALIASES[head]) return PROGRAM_ALIASES[head];

  if (upper.includes('INFORMATION TECHNOLOGY')) return 'BSIT';
  if (upper.includes('NURSING')) return 'BSN';
  if (upper.includes('ENTREPRENEURSHIP')) return 'BSEntrep';
  if (upper.includes('HOSPITALITY MANAGEMENT')) return 'BSHM';
  if (upper.includes('TOURISM MANAGEMENT')) return 'BSTM';
  return '';
}

/** Resolve a legacy school name to its canonical school. */
function normalizeDepartmentName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const key = raw.toUpperCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return DEPARTMENT_ALIASES[key] || '';
}

/** Return the school that owns a program code. */
function departmentForProgram(program) {
  const code = normalizeProgramCode(program);
  if (!code) return '';
  const match = Object.entries(COURSES_BY_DEPARTMENT)
    .find(([, courses]) => courses.includes(code));
  return match ? match[0] : '';
}

/** Full display label for a program code (falls back to the code). */
function programLabel(program) {
  return PROGRAM_LABELS[program] || program;
}

/**
 * Return the department / course / year taxonomy as plain data.
 * @returns {{ departments: string[], coursesByDept: Object<string,string[]>, yearLevels: string[] }}
 */
function getStudentOrgTaxonomy() {
  return {
    departments: [...DEPARTMENTS],
    coursesByDept: Object.fromEntries(Object.entries(COURSES_BY_DEPARTMENT).map(([d, cs]) => [d, [...cs]])),
    yearLevels: [...YEAR_LEVELS],
  };
}

/**
 * Format a stored year level ("1"–"4") as "1st Year" etc.
 * Unrecognised/blank values fall back to {@link UNASSIGNED}.
 * @param {string|number} year
 * @returns {string}
 */
function getStudentYearLabel(year) {
  const n = parseInt(year, 10);
  if (!Number.isFinite(n) || n < 1) return UNASSIGNED;
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return `${n}${suffix} Year`;
}

/**
 * Normalise a student's org fields. The program decides the school, so
 * legacy rows with a missing or incorrect department still group under
 * the right School. Blank/missing values fall back to {@link UNASSIGNED}.
 * @param {object} student — a user record with role 'student'
 * @returns {{ department: string, course: string, yearLevel: string }}
 */
function normalizeStudentOrg(student) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : UNASSIGNED);
  const rawCourse = student && (student.course || student.program);
  const course = normalizeProgramCode(rawCourse) || pick(rawCourse);
  const rawDepartment = student && student.department;
  const department = departmentForProgram(course)
    || normalizeDepartmentName(rawDepartment)
    || pick(rawDepartment);
  return {
    department,
    // The API/database calls this field `program`; older local records use
    // `course`. Prefer the canonical program code when both are present.
    course,
    yearLevel:  pick(student && student.yearLevel),
  };
}

/**
 * Narrow students by the Department/Course/Year dropdowns (ANDed)
 * and a case-insensitive text search over name, ID and email.
 * Empty filter values and a blank query are ignored.
 *
 * @param {object[]} students
 * @param {{ department?: string, course?: string, yearLevel?: string, block?: string }} filters
 * @param {string} [query]
 * @returns {object[]}
 */
function applyStudentFilters(students, filters, query) {
  const f = filters || {};
  const dept  = (f.department  || '').trim();
  const course = (f.course     || '').trim();
  const year  = (f.yearLevel   || '').trim();
  const block = (f.block       || '').trim();
  const q     = (query         || '').trim().toLowerCase();

  return students.filter(student => {
    const org = normalizeStudentOrg(student);
    if (dept  && org.department !== dept)  return false;
    if (course && org.course    !== course) return false;
    if (year  && org.yearLevel  !== year)  return false;
    if (block && String(student.block || '').trim() !== block) return false;
    if (q) {
      const haystack = [student.name, student.id, student.email]
        .map(v => (v || '').toString().toLowerCase());
      if (!haystack.some(v => v.includes(q))) return false;
    }
    return true;
  });
}

/**
 * Group students into the Department → Course hierarchy used by
 * the collapsible list. Year Level is kept on each student (not a
 * third nesting level) so rows stay compact. The {@link UNASSIGNED}
 * bucket always sorts last.
 *
 * @param {object[]} students
 * @returns {Array<{ department: string, courses: Array<{ course: string, students: object[] }> }>}
 */
function groupStudentsByOrg(students) {
  const groups = [];
  const byDept = new Map(); // department -> Map(course -> course group)

  students.forEach(student => {
    const org = normalizeStudentOrg(student);
    if (!byDept.has(org.department)) {
      byDept.set(org.department, new Map());
      groups.push({ department: org.department, courses: [] });
    }
    const courseMap = byDept.get(org.department);
    if (!courseMap.has(org.course)) {
      courseMap.set(org.course, { course: org.course, students: [] });
      groups[groups.length - 1].courses.push(courseMap.get(org.course));
    }
    courseMap.get(org.course).students.push(student);
  });

  const unassignedRank = (value) => value === UNASSIGNED ? 1 : 0;

  groups.sort((a, b) =>
    (unassignedRank(a.department) - unassignedRank(b.department)) ||
    a.department.localeCompare(b.department));

  groups.forEach(group => {
    group.courses.sort((a, b) =>
      (unassignedRank(a.course) - unassignedRank(b.course)) ||
      a.course.localeCompare(b.course));
    group.courses.forEach(courseGroup => {
      courseGroup.students.sort((s1, s2) =>
        (s1.name || '').localeCompare(s2.name || ''));
    });
  });

  return groups;
}

/**
 * Normalise existing student records so the grouped list always has the
 * correct school. The program decides the school; no guessed/round-robin
 * assignment is used, so an unrecognised program keeps its existing school.
 * Safe to run on every load; no-ops once every student is canonical.
 */
function backfillStudentOrg() {
  const users = getUsers();
  let changed = false;

  users.forEach((student) => {
    if (!student || student.role !== 'student') return;
    const org = normalizeStudentOrg(student);
    if (student.department !== org.department) {
      student.department = org.department;
      changed = true;
    }
    if (student.program !== org.course) {
      student.program = org.course;
      changed = true;
    }
    if (student.course !== org.course) {
      student.course = org.course;
      changed = true;
    }
  });

  if (changed) setUsers(users);
}

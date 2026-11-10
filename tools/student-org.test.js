/* Tests for program → school normalization and grouped student lists.
 *
 * Run: node tools/student-org.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const dataSource = fs.readFileSync(
  path.join(ROOT, 'student-attendance-system', 'js', 'data.js'),
  'utf8'
);
const seedSource = fs.readFileSync(
  path.join(ROOT, 'attendly-backend', 'scripts', 'seed-demo-users.php'),
  'utf8'
);

const store = new Map();
const localStorage = {
  get length() { return store.size; },
  key(i) { return Array.from(store.keys())[i] ?? null; },
  getItem(k) { return store.has(k) ? store.get(k) : null; },
  setItem(k, v) { store.set(k, String(v)); },
  removeItem(k) { store.delete(k); },
};

let pass = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) pass++;
  else failures.push(name + (detail !== undefined ? ' -> ' + detail : ''));
}

function makeContext() {
  const context = vm.createContext({
    localStorage, console, Date, JSON, Math, Object, Array, String, Number,
    RegExp, Uint32Array, Set, Map, isNaN, parseInt, setTimeout, clearTimeout,
  });
  vm.runInContext(dataSource, context);
  return context;
}

const context = makeContext();
const run = (script) => vm.runInContext(script, context);

/* ── Canonical taxonomy ─────────────────────────────────────────── */

ok('Computer Studies owns BSIT',
  run("departmentForProgram('BSIT')") === 'School of Computer Studies');
ok('Nursing owns BSN',
  run("departmentForProgram('BSN')") === 'School of Nursing');
ok('Business Management owns BSEntrep',
  run("departmentForProgram('BSEntrep')") === 'School of Business Management');
ok('Business Management owns BSHM',
  run("departmentForProgram('BSHM')") === 'School of Business Management');
ok('Business Management owns BSTM',
  run("departmentForProgram('BSTM')") === 'School of Business Management');

/* ── Legacy/full program values ─────────────────────────────────── */

ok('legacy BSIT full name resolves',
  run("normalizeProgramCode('BSIT – Bachelor of Science in Information Technology')") === 'BSIT');
ok('legacy BSN full name resolves',
  run("normalizeProgramCode('BSN – Bachelor of Science in Nursing')") === 'BSN');
ok('legacy BSE full name resolves to BSEntrep',
  run("normalizeProgramCode('BSE – Bachelor of Science in Entrepreneurship')") === 'BSEntrep');
ok('legacy BSHM full name resolves',
  run("normalizeProgramCode('BSHM – Bachelor of Science in Hospitality Management')") === 'BSHM');
ok('legacy BSTM full name resolves',
  run("normalizeProgramCode('BSTM – Bachelor of Science in Tourism Management')") === 'BSTM');

/* ── Student normalization ──────────────────────────────────────── */

ok('BSIT student in Unassigned moves to SCS',
  run("JSON.stringify(normalizeStudentOrg({department:'Unassigned',program:'BSIT'}))") ===
    JSON.stringify({ department: 'School of Computer Studies', course: 'BSIT', yearLevel: 'Unassigned' }));
ok('BSN student cannot remain under Computer Studies',
  run("normalizeStudentOrg({department:'School of Computing Studies',program:'BSN'}).department") ===
    'School of Nursing');
ok('legacy program stored under the wrong school is corrected',
  run("normalizeStudentOrg({department:'School of Nursing',program:'BSIT – Bachelor of Science in Information Technology'}).department") ===
    'School of Computer Studies');
ok('BSEntrep is grouped under Business Management',
  run("normalizeStudentOrg({department:'Unassigned',program:'BSEntrep'}).department") ===
    'School of Business Management');

/* ── Grouped list ───────────────────────────────────────────────── */

const groups = JSON.parse(run(`JSON.stringify(groupStudentsByOrg([
  { id: 1, role: 'student', name: 'IT Student', department: 'Unassigned', program: 'BSIT' },
  { id: 2, role: 'student', name: 'Nurse Student', department: 'Unassigned', program: 'BSN' },
  { id: 3, role: 'student', name: 'Entrepreneur Student', department: 'Unassigned', program: 'BSEntrep' },
  { id: 4, role: 'student', name: 'Hospitality Student', department: 'Unassigned', program: 'BSHM' },
  { id: 5, role: 'student', name: 'Tourism Student', department: 'Unassigned', program: 'BSTM' }
]))`));

const groupByName = Object.fromEntries(groups.map((g) => [g.department, g]));
ok('no student remains in Unassigned after grouping', !groupByName.Unassigned);
ok('three canonical schools are produced', groups.length === 3);
ok('SCS contains only BSIT',
  groupByName['School of Computer Studies'].courses.length === 1 &&
  groupByName['School of Computer Studies'].courses[0].course === 'BSIT');
ok('Nursing contains only BSN',
  groupByName['School of Nursing'].courses.length === 1 &&
  groupByName['School of Nursing'].courses[0].course === 'BSN');
ok('Business Management contains three programs',
  groupByName['School of Business Management'].courses.map((c) => c.course).join(',') ===
    'BSEntrep,BSHM,BSTM');

/* ── Backfill persists canonical values ─────────────────────────── */

localStorage.setItem('attendly_users', JSON.stringify([
  { id: 10, role: 'student', name: 'Legacy IT', department: 'Unassigned', program: 'BSIT' },
  { id: 11, role: 'student', name: 'Legacy Nurse', department: 'Unassigned', program: 'BSN' },
]));
run('backfillStudentOrg();');
const backfilled = JSON.parse(localStorage.getItem('attendly_users'));
ok('backfill writes the derived SCS school', backfilled[0].department === 'School of Computer Studies');
ok('backfill writes the derived Nursing school', backfilled[1].department === 'School of Nursing');
ok('backfill canonicalizes the program code', backfilled[0].program === 'BSIT' && backfilled[0].course === 'BSIT');

/* ── Demo accounts must not be reseeded ─────────────────────────── */

for (const email of ['alice@example.com', 'bob@example.com', 'maria@example.com', 'mac@example.com']) {
  ok(`seed script no longer contains ${email}`, !seedSource.includes(email));
}

/* ── Report ─────────────────────────────────────────────────────── */

if (failures.length) {
  console.log(`  ${pass} passed, ${failures.length} FAILED:`);
  for (const failure of failures) console.log('    - ' + failure);
  process.exit(1);
}
console.log(`  ${pass} student-org assertions passed`);

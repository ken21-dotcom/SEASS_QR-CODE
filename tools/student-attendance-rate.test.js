/* Student attendance-rate test
 *
 * The dashboard rate must only count events that have already ended.
 * Future or in-progress events are not absences, so including them made
 * the percentage fall as more of the semester was scheduled.
 *
 * Runs the real functions from student.js in a VM (the file's only
 * top-level browser dependency is document.addEventListener).
 *
 * Run: node tools/student-attendance-rate.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STUDENT_JS = fs.readFileSync(
  path.join(ROOT, 'student-attendance-system', 'js', 'student.js'),
  'utf8'
);

let failures = 0;
let passed = 0;

function section(name) {
  console.log('\n' + name);
}

function ok(name, passedFlag, detail) {
  if (passedFlag) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

const context = { document: { addEventListener() {} } };
vm.createContext(context);
vm.runInContext(STUDENT_JS, context, { filename: 'student.js' });

const calculateAttendanceRate = context.calculateAttendanceRate;
const hasEventEnded = context.hasEventEnded;

// Fixed "now" keeps the assertions independent of the wall clock.
const NOW = new Date('2026-11-03T12:00:00');

function event(id, date, endTime) {
  return { id, date, endTime };
}

function record(status) {
  return { studentId: 1, status };
}

function rate(events, attendance) {
  return calculateAttendanceRate(events, attendance, NOW);
}

section('Ended-event detection');

ok('past event has ended', hasEventEnded(event('e1', '2026-10-01', '17:00'), NOW) === true);
ok('future event has not ended', hasEventEnded(event('e2', '2026-12-01', '17:00'), NOW) === false);
ok('event still in progress has not ended', hasEventEnded(event('e3', '2026-11-03', '17:00'), NOW) === false);
ok('event ending exactly now counts as ended', hasEventEnded(event('e4', '2026-11-03', '12:00'), NOW) === true);
ok(
  'event without an end time is not counted until its day is over',
  hasEventEnded(event('e5', '2026-11-03', null), NOW) === false
);
ok(
  'past event without an end time has ended',
  hasEventEnded(event('e6', '2026-11-02', null), NOW) === true
);
ok('malformed dates are ignored', hasEventEnded(event('e7', 'not-a-date', '17:00'), NOW) === false);

section('Attendance rate');

ok('no events and no check-ins is 0%', rate([], []) === 0);
ok('one ended event, one present check-in is 100%', rate([event('e1', '2026-10-01', '17:00')], [record('present')]) === 100);
ok('one ended event, absent only is 0%', rate([event('e1', '2026-10-01', '17:00')], [record('absent')]) === 0);
ok(
  'a late check-in counts as attended',
  rate([event('e1', '2026-10-01', '17:00')], [record('late')]) === 100
);
ok(
  'future events do not lower the rate',
  rate(
    [event('e1', '2026-10-01', '17:00'), event('e2', '2026-12-01', '17:00'), event('e3', '2027-01-15', '17:00')],
    [record('present')]
  ) === 100
);
ok(
  'two ended events, one present is 50%',
  rate(
    [event('e1', '2026-10-01', '17:00'), event('e2', '2026-10-08', '17:00')],
    [record('present')]
  ) === 50
);
ok(
  'an in-progress event is not counted as an absence',
  rate([event('e1', '2026-11-03', '17:00')], []) === 0
);
ok(
  'an in-progress event does not dilute an ended event',
  rate(
    [event('e1', '2026-10-01', '17:00'), event('e2', '2026-11-03', '17:00')],
    [record('present')]
  ) === 100
);
ok(
  'check-ins floor the denominator when events are missing',
  rate([], [record('present')]) === 100
);
ok(
  'two of three ended events is 67% (rounded)',
  rate(
    [
      event('e1', '2026-10-01', '17:00'),
      event('e2', '2026-10-08', '17:00'),
      event('e3', '2026-10-15', '17:00'),
    ],
    [record('present'), record('late')]
  ) === 67
);

section('Dashboard wires the helper in');

ok(
  'loadStudentDashboard calls calculateAttendanceRate',
  /calculateAttendanceRate\(events, attendance\)/.test(STUDENT_JS)
);
ok(
  'the old all-events denominator is gone',
  !/Math\.max\(events\.length, presentCount\)/.test(STUDENT_JS)
);

section('Attendance-rate test summary');
console.log(`  ${passed} assertion${passed !== 1 ? 's' : ''} passed, ${failures} FAILED`);
if (failures > 0) {
  process.exit(1);
}
console.log('All attendance-rate assertions passed.');

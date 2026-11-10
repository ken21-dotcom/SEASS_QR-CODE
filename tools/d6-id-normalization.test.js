'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SYS = path.join(ROOT, 'student-attendance-system', 'js');

function read(name) {
  return fs.readFileSync(path.join(SYS, name), 'utf8');
}

const dataSource = read('data.js');
const uiSource = read('ui.js');
const sscSource = read('ssc.js');
const adminSource = read('administrator-panel.js');
const studentSource = read('student.js');

let pass = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) pass++;
  else failures.push(name + (detail ? ' -> ' + detail : ''));
}

const STRICT_ID = /\.(?:id|studentId|eventId|sanctionId|adminId|officerId|requestId|templateId)\s*[=!]==(?!\s*undefined\b)/;
const STRING_ID = /String\([^)]*\b(?:id|studentId|eventId|sanctionId|adminId|officerId|requestId|templateId)\b[^)]*\)\s*[=!]==/;

for (const [name, source] of [
  ['data.js', dataSource],
  ['ssc.js', sscSource],
  ['administrator-panel.js', adminSource],
  ['ui.js', uiSource],
  ['student.js', studentSource],
]) {
  const lines = source.split(/\r?\n/);
  ok(`${name} has no strict id comparisons`, !lines.some((line) => STRICT_ID.test(line)));
  ok(`${name} has no stringified strict id comparisons`, !lines.some((line) => STRING_ID.test(line)));
}

// Records are matched through sameId() now, never through a raw id-keyed
// map, so a numeric API id and its string form resolve to one row.
ok('ssc.js normalises user id lookups',
  !/\[u\.id,\s*u\]/.test(sscSource) &&
  !/userMap\.get\((?!String\()/.test(sscSource) &&
  sscSource.includes('sameId('));
ok('administrator-panel.js normalises user id lookups',
  !/\b(?:s|u|user)\.id,\s*(?:s|u|user)\]/.test(adminSource) &&
  !/userMap\.get\((?!String\()/.test(adminSource) &&
  /sameId\(u\.id,/.test(adminSource));

const localStore = new Map();
const localStorage = {
  get length() { return localStore.size; },
  key(i) { return Array.from(localStore.keys())[i] ?? null; },
  getItem(key) { return localStore.has(key) ? localStore.get(key) : null; },
  setItem(key, value) { localStore.set(key, String(value)); },
  removeItem(key) { localStore.delete(key); },
};

const context = {
  console,
  localStorage,
  document: {
    addEventListener() {},
    getElementById() { return null; },
  },
};

vm.createContext(context);
vm.runInContext(dataSource, context);
vm.runInContext(uiSource, context);

const sameId = context.sameId;
ok('sameId matches a number to its numeric string', sameId(7, '7'));
ok('sameId matches zero to its string form', sameId(0, '0'));
ok('sameId matches identical strings', sameId('abc', 'abc'));
ok('sameId rejects different ids', !sameId(7, 8));
ok('sameId rejects null', !sameId(null, '7'));
ok('sameId rejects undefined on both sides', !sameId(undefined, undefined));
ok('sameId does not trim or coerce whitespace', !sameId(7, ' 7'));

// Absence counting now lives in the sanction matrix (Repository.php), so
// data.js must not keep a second, ID-coercion-sensitive copy of it.
ok('data.js no longer carries computeUnexcusedAbsences',
  typeof context.computeUnexcusedAbsences === 'undefined');

context.getSession = () => ({ id: '1', mustChangePassword: false });
context.getUsers = () => [{ id: 1, name: 'Ana Student', role: 'student', mustChangePassword: true }];
context.isApiEnabled = () => true;
const currentUser = context.getCurrentUser();
ok('data.js getCurrentUser matches a numeric cached id to a string session id',
  currentUser && currentUser.id === 1 && currentUser.mustChangePassword === true,
  JSON.stringify(currentUser));

let events = [
  { id: 7, name: 'API event' },
  { id: 'evt_local', name: 'Local event' },
];
let attendance = [
  { eventId: 7 },
  { eventId: 'evt_local' },
  { eventId: 8 },
];
const apiCalls = [];

context.confirm = () => true;
context.showToast = () => {};
context.getEvents = () => events;
context.setEvents = (next) => { events = next; };
context.getAttendance = () => attendance;
context.setAttendance = (next) => { attendance = next; };
context.api = {
  deleteEvent(id) {
    apiCalls.push(id);
    return Promise.resolve({});
  },
};

vm.runInContext(sscSource, context);

context.deleteEvent('7');
ok('deleteEvent removes an API event selected by a string id',
  events.length === 1 && events[0].id === 'evt_local',
  JSON.stringify(events));
ok('deleteEvent removes that event attendance',
  attendance.length === 2 && attendance.every((record) => record.eventId !== 7),
  JSON.stringify(attendance));
ok('deleteEvent sends the canonical numeric id to the API',
  apiCalls.length === 1 && apiCalls[0] === 7,
  JSON.stringify(apiCalls));

context.deleteEvent('evt_local');
ok('deleteEvent removes a local event selected by a string id',
  events.length === 0, JSON.stringify(events));
ok('deleteEvent does not call the API for a local-only event',
  apiCalls.length === 1, JSON.stringify(apiCalls));

if (failures.length === 0) {
  console.log(`  ${pass} id-normalization assertions passed`);
  process.exit(0);
}
console.log(`  ${pass} passed, ${failures.length} FAILED:`);
for (const failure of failures) console.log('    - ' + failure);
process.exit(1);

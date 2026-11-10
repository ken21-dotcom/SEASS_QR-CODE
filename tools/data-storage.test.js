/* Tests for the local storage lifecycle.
 *
 * data.js runs against a fake localStorage so the wipe/preserve rules can
 * be proven without a browser. The important promises are:
 *   - a clean install starts with empty collections,
 *   - an old schema version wipes attendly_* exactly once,
 *   - unrelated origin keys (theme) survive,
 *   - resetAllData leaves the browser cache empty again.
 *
 * Run: node tools/data-storage.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/data.js'), 'utf8');

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

// Each run gets a fresh global scope: data.js declares top-level consts,
// which cannot be redeclared inside the same context.
function runData(extra) {
  const context = vm.createContext({
    localStorage, console, Date, JSON, Math, Object, Array, String, Number,
    RegExp, Uint32Array, Set, Map, isNaN, parseInt, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  if (extra) vm.runInContext(extra, context);
}

/* ── Fresh install ─────────────────────────────────────────────── */

runData();
ok('users start empty', JSON.parse(localStorage.getItem('attendly_users')).length === 0);
ok('events start empty', JSON.parse(localStorage.getItem('attendly_events')).length === 0);
ok('attendance starts empty', JSON.parse(localStorage.getItem('attendly_attendance')).length === 0);
ok('version marker written', localStorage.getItem('attendly_data_version') === '6-qr');
ok('no sanction policy cache is seeded', localStorage.getItem('attendly_sanction_policy') === null);

/* ── Same version preserves data ──────────────────────────────── */

localStorage.setItem('attendly_users', JSON.stringify([{ id: 'adm_1', role: 'admin', name: 'Admin' }]));
runData();
ok('same version keeps users', JSON.parse(localStorage.getItem('attendly_users')).length === 1);

/* ── Legacy demo labels are stripped without a logout ─────────── */

localStorage.setItem('attendly_data_version', '6-qr');
localStorage.setItem('attendly_events', JSON.stringify([
  { id: 'evt_1', name: '[SEED] Acquaintance Party', description: '[DEMO] Sample event' },
]));
localStorage.setItem('attendly_sanctions', JSON.stringify([
  { id: 'r2', studentName: '[SEED] Nicole Salazar', reason: '[SEED]   Repeated tardiness' },
]));
localStorage.setItem('attendly_session', JSON.stringify({ id: 'usr_1', name: 'Admin' }));
localStorage.setItem('attendly_appeals', JSON.stringify([{ id: 1, status: 'pending' }]));
localStorage.setItem('attendly_broken', '[SEED] not valid json');
runData();
const cleanedEvents = JSON.parse(localStorage.getItem('attendly_events'));
const cleanedSanctions = JSON.parse(localStorage.getItem('attendly_sanctions'));
ok('event names lose the seed label', cleanedEvents[0].name === 'Acquaintance Party', cleanedEvents[0].name);
ok('event descriptions lose the demo label', cleanedEvents[0].description === 'Sample event', cleanedEvents[0].description);
ok('nested sanction text is cleaned', cleanedSanctions[0].studentName === 'Nicole Salazar' && cleanedSanctions[0].reason === 'Repeated tardiness');
ok('session survives the cleanup', JSON.parse(localStorage.getItem('attendly_session')).id === 'usr_1');
ok('legacy appeal cache is removed', localStorage.getItem('attendly_appeals') === null);
ok('malformed JSON is left untouched', localStorage.getItem('attendly_broken') === '[SEED] not valid json');
ok('cleanup does not force a re-login', localStorage.getItem('attendly_data_version') === '6-qr' && cleanedEvents.length === 1);

/* ── Old version wipes app keys once ──────────────────────────── */

localStorage.setItem('attendly_data_version', '4-fingerprint');
localStorage.setItem('attendly_events', JSON.stringify([{ id: 'evt_1' }]));
localStorage.setItem('theme', 'dark');
runData();
ok('old version wipes events', JSON.parse(localStorage.getItem('attendly_events')).length === 0);
ok('old version keeps unrelated keys', localStorage.getItem('theme') === 'dark');
ok('old version rewrites the marker', localStorage.getItem('attendly_data_version') === '6-qr');

/* ── resetAllData ─────────────────────────────────────────────── */

localStorage.setItem('attendly_users', JSON.stringify([{ id: 'adm_2' }]));
runData('resetAllData();');
ok('resetAllData clears users', JSON.parse(localStorage.getItem('attendly_users')).length === 0);
ok('resetAllData keeps the marker', localStorage.getItem('attendly_data_version') === '6-qr');
ok('resetAllData recreates collections', JSON.parse(localStorage.getItem('attendly_attendance')).length === 0);

/* ── Report ────────────────────────────────────────────────────── */

if (failures.length === 0) {
  console.log(`  ${pass} storage assertions passed`);
  process.exit(0);
}
console.log(`  ${pass} passed, ${failures.length} FAILED:`);
for (const failure of failures) console.log('    - ' + failure);
process.exit(1);

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dataSource = fs.readFileSync(
  path.join(__dirname, '..', 'student-attendance-system', 'js', 'data.js'),
  'utf8'
);
const uiSource = fs.readFileSync(
  path.join(__dirname, '..', 'student-attendance-system', 'js', 'ui.js'),
  'utf8'
);

let pass = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) pass++;
  else failures.push(name + (detail ? ' -> ' + detail : ''));
}

function makeElement() {
  return {
    value: '',
    innerHTML: '',
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    addEventListener(type, fn) {
      this.handlers = this.handlers || {};
      this.handlers[type] = fn;
    },
    focus() {},
    contains() { return true; },
    setAttribute() {},
  };
}

const USERS = [
  { id: 1, name: 'Ana Student', email: 'ana@example.com', role: 'student' },
  { id: 2, name: 'Officer One', email: 'officer@example.com', role: 'ssc-officer' },
];

function makeEnv(links) {
  const input = makeElement();
  const results = makeElement();
  const clear = makeElement();
  const wrap = makeElement();
  const elements = {
    globalSearchInput: input,
    searchResults: results,
    searchClear: clear,
    globalSearch: wrap,
  };

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
      getElementById(id) { return elements[id] || null; },
      addEventListener() {},
    },
  };

  vm.createContext(context);
  vm.runInContext(dataSource, context);
  context.getUsers = () => USERS;
  context.getEvents = () => [];
  context.getSanctions = () => [];
  vm.runInContext(uiSource, context);
  context.initGlobalSearch(links);

  return {
    search(query) {
      input.value = query;
      input.handlers.input.call(input);
      return results.innerHTML;
    },
  };
}

const ssc = makeEnv({
  students: 'ssc-manage-students.html',
  events: 'ssc-manage-events.html',
});

const sscOfficerHtml = ssc.search('officer');
ok('SSC search hides officers when no target is supplied',
  !sscOfficerHtml.includes('Officers'), sscOfficerHtml);
ok('SSC search never renders a dead link for officers',
  !sscOfficerHtml.includes('href="#"'), sscOfficerHtml);

const sscStudentHtml = ssc.search('ana');
ok('SSC search still renders students with their target',
  sscStudentHtml.includes('Ana Student') &&
  sscStudentHtml.includes('href="ssc-manage-students.html"'), sscStudentHtml);

const admin = makeEnv({
  students: 'admin-manage-students.html',
  officers: 'admin-manage-officers.html',
  events: 'admin-reports.html',
});

const adminOfficerHtml = admin.search('officer');
ok('admin search still renders officers with their target',
  adminOfficerHtml.includes('Officers') &&
  adminOfficerHtml.includes('href="admin-manage-officers.html"'), adminOfficerHtml);

if (failures.length === 0) {
  console.log(`  ${pass} global-search assertions passed`);
  process.exit(0);
}
console.log(`  ${pass} passed, ${failures.length} FAILED:`);
for (const failure of failures) console.log('    - ' + failure);
process.exit(1);

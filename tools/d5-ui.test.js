/* D5 source assertions: admin approvals, officer creation, SSC read-only
 * student records, global search, and seeded-password cleanup.
 *
 * These checks prove the intentionally removed local CRUD paths cannot
 * creep back into the source. The HTTP behaviour is covered separately.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SYS = path.join(ROOT, 'student-attendance-system');
const BACKEND = path.join(ROOT, 'attendly-backend');

let checks = 0;
let failures = 0;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function ok(name, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

function hasAll(source, needles) {
  return needles.every((needle) => source.includes(needle));
}

function walk(dir, filter) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (!filter || filter(full)) out.push(full);
  }
  return out;
}

const adminStudentsHtml = read('student-attendance-system/pages/administrator/admin-manage-students.html');
const adminStudentsJs = read('student-attendance-system/js/administrator-panel.js');
const adminOfficersHtml = read('student-attendance-system/pages/administrator/admin-manage-officers.html');
const sscStudentsHtml = read('student-attendance-system/pages/ssc-officer/ssc-manage-students.html');
const sscDashboardHtml = read('student-attendance-system/pages/ssc-officer/ssc-dashboard.html');
const sscJs = read('student-attendance-system/js/ssc.js');
const uiJs = read('student-attendance-system/js/ui.js');
const apiJs = read('student-attendance-system/js/api.js');
const repoPhp = read('attendly-backend/src/Repository.php');
const seedPhp = read('attendly-backend/scripts/seed-demo-users.php');
const configExamplePhp = read('attendly-backend/config/config.example.php');
const localConfigPath = path.join(BACKEND, 'config/config.php');
const localConfigPhp = fs.existsSync(localConfigPath)
  ? fs.readFileSync(localConfigPath, 'utf8')
  : '';

console.log('Admin student approvals');

ok('pending registrations table exists', adminStudentsHtml.includes('id="pendingRegistrationsBody"'));
ok('pending count badge exists', adminStudentsHtml.includes('id="pendingRegistrationsCount"'));
ok('pending refresh control exists', adminStudentsHtml.includes('id="refreshPendingRegistrations"'));
ok('student table exposes status', adminStudentsHtml.includes('<th>Status</th>'));
ok('local Add Student modal is gone', !adminStudentsHtml.includes('id="addStudentModal"'));
ok('local Add Student form is gone', !adminStudentsHtml.includes('id="addStudentForm"'));
ok('CSV import modal is gone', !adminStudentsHtml.includes('id="importCsvModal"'));
ok('CSV import form is gone', !adminStudentsHtml.includes('id="importCsvForm"'));
ok('pending list uses the filtered API',
  adminStudentsJs.includes("api.listUsers('pending', 'student')"));
ok('approve and reject call the status API',
  adminStudentsJs.includes('api.updateUserStatus') &&
  adminStudentsJs.includes('approvePendingStudent') &&
  adminStudentsJs.includes('rejectPendingStudent'));
ok('student deactivate/reactivate call the status API',
  adminStudentsJs.includes('deactivateStudent') &&
  adminStudentsJs.includes('reactivateStudent'));
ok('local deleteStudent handler is gone', !adminStudentsJs.includes('function deleteStudent'));
ok('pending rows are excluded from the main student list',
  adminStudentsJs.includes("!== 'pending'"));
ok('main student table has seven columns', adminStudentsJs.includes('colspan: 7'));

console.log('\nAdmin officer creation');

ok('officer first-name field exists', adminOfficersHtml.includes('id="officerFirstName"'));
ok('officer last-name field exists', adminOfficersHtml.includes('id="officerLastName"'));
ok('officer email field exists', adminOfficersHtml.includes('id="officerEmail"'));
ok('officer position field exists', adminOfficersHtml.includes('id="officerPosition"'));
ok('officer password field is a password input',
  adminOfficersHtml.includes('type="password"') &&
  adminOfficersHtml.includes('id="officerPassword"'));
ok('officer password requires eight characters',
  adminOfficersHtml.includes('minlength="8"'));
ok('officer creation calls the API helper', adminStudentsJs.includes('api.createOfficer'));
ok('officer create payload includes every API field', hasAll(adminStudentsJs, [
  'firstName:', 'lastName:', 'email:', 'position:', 'password:',
]));
ok('officer status actions use the status API',
  adminStudentsJs.includes('changeOfficerStatus') &&
  adminStudentsJs.includes('api.updateUserStatus'));
ok('local deleteOfficer handler is gone', !adminStudentsJs.includes('function deleteOfficer'));
ok('no default password is advertised', !adminOfficersHtml.toLowerCase().includes('default password'));

console.log('\nSSC student records and officer cleanup');

ok('SSC officer management page is deleted',
  !fs.existsSync(path.join(SYS, 'pages/ssc-officer/ssc-manage-officers.html')));
const allUiFiles = walk(SYS, (file) => file.endsWith('.js') || file.endsWith('.html'));
const officerPageRefs = allUiFiles.filter((file) =>
  fs.readFileSync(file, 'utf8').includes('ssc-manage-officers'));
ok('no SSC page or script links to the deleted officer page',
  officerPageRefs.length === 0,
  officerPageRefs.map((file) => path.relative(SYS, file)).join(','));
ok('SSC student page has no Add Student modal', !sscStudentsHtml.includes('id="addStudentModal"'));
ok('SSC student page has no Add Student form', !sscStudentsHtml.includes('id="addStudentForm"'));
ok('SSC student page has no Actions column', !sscStudentsHtml.includes('<th>Actions</th>'));
ok('SSC student table has five columns', sscJs.includes('colspan: 5'));
ok('SSC deleteUser handler is gone', !sscJs.includes('function deleteUser'));
ok('SSC officer table handler is gone', !sscJs.includes('loadOfficersTable'));
ok('SSC officer form handler is gone', !sscJs.includes('addOfficerForm'));
ok('SSC dashboard has no officer search target',
  !sscDashboardHtml.includes('officers:'));
ok('shared search has no default officer target',
  !/officers:\s*'#'/.test(uiJs) &&
  uiJs.includes('officers.length && targets.officers'));

console.log('\nPassword cleanup');

ok('administrator-panel.js has no password123', !adminStudentsJs.includes('password123'));
ok('ssc.js has no password123', !sscJs.includes('password123'));
ok('seed script reads ATTENDLY_SEED_PASSWORD',
  seedPhp.includes("getenv('ATTENDLY_SEED_PASSWORD')"));
ok('seed script fails when the environment variable is absent',
  seedPhp.includes('ATTENDLY_SEED_PASSWORD is required'));
ok('seed script has no password123', !seedPhp.includes('password123'));
ok('seed script has no DEMO_PASSWORD constant', !seedPhp.includes('DEMO_PASSWORD'));
ok('config.example.php has no default admin block', !configExamplePhp.includes('default_admin'));
ok('config.php has no default admin block', !localConfigPhp.includes('default_admin'));
ok('config.example.php has no seeded password123', !configExamplePhp.includes('password123'));
ok('config.php has no seeded password123', !localConfigPhp.includes('password123'));

console.log('\nAPI and backend contracts');

ok('api.listUsers accepts status and role filters',
  apiJs.includes('listUsers: function (status, role)'));
ok('api.updateUserStatus uses PATCH',
  apiJs.includes('updateUserStatus') && apiJs.includes("method: 'PATCH'"));
ok('api.createOfficer posts to the officer endpoint',
  apiJs.includes('createOfficer') && apiJs.includes("'/users/officers'"));
ok('api.js no longer exposes a student create helper', !apiJs.includes('createStudent'));
ok('api.js no longer lists a student create path', !apiJs.includes('student create'));
ok('api.js documents officer status changes as synced',
  /officer create \/ status change \.+ synced/.test(apiJs));
ok('pending accounts can be rejected as inactive',
  repoPhp.includes("'pending'  => ['active', 'inactive']"));

console.log('');
if (failures) {
  console.log(`${failures} of ${checks} D5 checks failed.`);
  process.exit(1);
}
console.log(`${checks} D5 source checks passed.`);

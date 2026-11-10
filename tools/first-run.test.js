/* Tests for the API-backed first-run and auth flow.
 *
 * The app starts with empty localStorage collections. These assertions
 * cover the one-time storage wipe, the rule that sign-up sends the full
 * student contract to POST /auth/register without signing anyone in, and
 * the rule that login failures never fall back to local credentials.
 *
 * Run: node tools/first-run.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const dataSource = fs.readFileSync(path.join(ROOT, 'student-attendance-system', 'js', 'data.js'), 'utf8');
const authSource = fs.readFileSync(path.join(ROOT, 'student-attendance-system', 'js', 'auth.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(ROOT, 'student-attendance-system', 'js', 'api.js'), 'utf8');
const loginHtml = fs.readFileSync(path.join(ROOT, 'student-attendance-system', 'pages', 'login.html'), 'utf8');
const signupHtml = fs.readFileSync(path.join(ROOT, 'student-attendance-system', 'pages', 'signup.html'), 'utf8');
const changeHtml = fs.readFileSync(path.join(ROOT, 'student-attendance-system', 'pages', 'change-password.html'), 'utf8');
const authCss = fs.readFileSync(path.join(ROOT, 'student-attendance-system', 'css', 'auth.css'), 'utf8');

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

function authError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function makeEnv(options) {
  const opts = options || {};
  const env = {
    localStorage,
    console,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    RegExp,
    Uint32Array,
    Set,
    Map,
    isNaN,
    parseInt,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    API_BASE_URL: 'http://localhost:8000/api',
    api: opts.api || {},
    toasts: [],
    hydrated: 0,
    isApiEnabled: function () {
      return String(env.API_BASE_URL || '').trim() !== '';
    },
    showToast: (type, message) => { env.toasts.push({ type, message }); },
    hydrateFromApi: async () => { env.hydrated++; return { synced: [], failed: [] }; },
    document: {
      getElementsByTagName: () => [{ src: 'http://localhost:5173/student-attendance-system/js/auth.js' }],
      addEventListener: () => {},
    },
    window: {
      location: {
        href: '',
        pathname: '/student-attendance-system/pages/login.html',
        replace: function (url) { this.href = url; },
      },
    },
  };

  // Each scenario starts signed out; the storage bootstrap assertions
  // still share the same store so their wipe check stays meaningful.
  localStorage.removeItem('attendly_session');

  const context = vm.createContext(env);
  vm.runInContext(dataSource, context);
  vm.runInContext(authSource, context);
  return context;
}

function users() {
  return JSON.parse(localStorage.getItem('attendly_users'));
}

const STUDENT = {
  firstName: 'Ana',
  lastName: 'Dela Cruz',
  studentIdNumber: 'JHC-2024-001',
  email: 'ANA@example.com',
  password: 'password123',
  department: 'College of Information Technology',
  program: 'BSIT - Bachelor of Science in Information Technology',
  yearLevel: '1',
  block: 'A',
};

/* ── Storage bootstrap ─────────────────────────────────────────── */

store.clear();
localStorage.setItem('attendly_data_version', '4-fingerprint');
localStorage.setItem('attendly_users', JSON.stringify([{ id: 'old-user' }]));
localStorage.setItem('theme', 'dark');

const context = makeEnv();
ok('old users wiped', users().length === 0);
ok('unrelated preference kept', localStorage.getItem('theme') === 'dark');
ok('version marker set', localStorage.getItem('attendly_data_version') === '6-qr');
ok('events start empty', JSON.parse(localStorage.getItem('attendly_events')).length === 0);
ok('no sanction policy cache is seeded', localStorage.getItem('attendly_sanction_policy') === null);

/* A cached row must not hide the temporary-password flag from login. */
context.setUsers([{
  id: 42, role: 'ssc-officer', name: 'Temp Officer',
  email: 'temp@example.com', mustChangePassword: false,
}]);
context.setSession({
  id: 42, role: 'ssc-officer', name: 'Temp Officer',
  email: 'temp@example.com', mustChangePassword: true,
});
ok('cached user inherits the session password flag',
  context.getCurrentUser().mustChangePassword === true);
context.window.location.href = '';
const guarded = context.requireAuth('ssc-officer');
ok('guard routes a temporary password to the change page',
  guarded === null && /change-password\.html$/.test(context.window.location.href));
context.clearSession();
context.setUsers([]);

/* ── Registration goes to the API, pending, without a session ──── */

(async () => {
  let posted = null;
  const signupEnv = makeEnv({
    api: {
      registerStudent: async function (payload) {
        posted = payload;
        return { ok: true, message: 'OTP Sent' };
      },
    },
  });

  const created = await signupEnv.registerAccount(STUDENT);
  ok('signup accepted by the API', created && created.ok === true);
  ok('signup posts the register contract', posted !== null);
  ok('first name sent', posted && posted.firstName === 'Ana');
  ok('last name sent', posted && posted.lastName === 'Dela Cruz');
  ok('student ID number sent', posted && posted.studentIdNumber === 'JHC-2024-001');
  ok('block sent', posted && posted.block === 'A');
  ok('program sent as the canonical code (not course)',
    posted && posted.program === 'BSIT' && !('course' in posted), posted && posted.program);
  ok('department derived from the program',
    posted && posted.department === 'School of Computer Studies', posted && posted.department);
  ok('email normalised', posted && posted.email === 'ana@example.com', posted && posted.email);
  ok('signup creates no local account', users().length === 0);
  ok('signup starts no session', signupEnv.getCurrentUser() === null);

  const refusedEnv = makeEnv({
    api: {
      registerStudent: async function () {
        throw authError('email_taken', 'An account with that email already exists.');
      },
    },
  });
  const refused = await refusedEnv.registerAccount(STUDENT);
  ok('server rejection returns false', refused === false);
  ok('server rejection creates no local account', users().length === 0);
  ok('server rejection starts no session', refusedEnv.getCurrentUser() === null);
  ok('server rejection is surfaced', refusedEnv.toasts.some(t => t.type === 'error' && /already exists/.test(t.message)));

  /* ── Login is API-only ───────────────────────────────────────── */

  const loginEnv = makeEnv({
    api: {
      login: async function () {
        return { id: 9, name: 'System Admin', email: 'admin@example.com', role: 'admin', mustChangePassword: false };
      },
    },
  });
  const loggedIn = await loginEnv.loginWithCredentials('admin@example.com', 'password123');
  ok('API login succeeds', loggedIn === true);
  ok('session stores the safe user', loginEnv.getCurrentUser() && loginEnv.getCurrentUser().role === 'admin');
  ok('successful login hydrates', loginEnv.hydrated === 1);
  ok('successful login redirects to the role page', /administrator\/admin-dashboard\.html$/.test(loginEnv.window.location.href), loginEnv.window.location.href);

  const pendingEnv = makeEnv({
    api: {
      login: async function () {
        throw authError('account_pending', 'Your account is awaiting administrator approval.');
      },
    },
  });
  const pendingLogin = await pendingEnv.loginWithCredentials('ana@example.com', 'password123');
  ok('pending login is rejected', pendingLogin === false);
  ok('pending login starts no session', pendingEnv.getCurrentUser() === null);
  ok('pending login explains approval', pendingEnv.toasts.some(t => /awaiting administrator approval/.test(t.message)));
  ok('pending login does not hydrate', pendingEnv.hydrated === 0);

  const deactivatedEnv = makeEnv({
    api: {
      login: async function () {
        throw authError('account_deactivated', 'This account has been deactivated.');
      },
    },
  });
  const deactivatedLogin = await deactivatedEnv.loginWithCredentials('ana@example.com', 'password123');
  ok('deactivated login is rejected', deactivatedLogin === false);
  ok('deactivated login starts no session', deactivatedEnv.getCurrentUser() === null);

  // A local row with the right password must never rescue a failed API login.
  const fallbackEnv = makeEnv({
    api: {
      login: async function () {
        throw authError('network_error', 'Cannot reach the server. Check that the backend is running.');
      },
    },
  });
  fallbackEnv.setUsers([{
    id: 'local-student',
    name: 'Local Student',
    email: 'local@example.com',
    password: fallbackEnv.hashPassword('password123'),
    role: 'student',
  }]);
  const fallbackLogin = await fallbackEnv.loginWithCredentials('local@example.com', 'password123');
  ok('network failure does not fall back to local credentials', fallbackLogin === false);
  ok('network failure leaves the session empty', fallbackEnv.getCurrentUser() === null);
  ok('network failure is surfaced', fallbackEnv.toasts.some(t => /Cannot reach the server/.test(t.message)));

  /* ── Temporary password must be changed before a dashboard ───── */

  const temporaryEnv = makeEnv({
    api: {
      login: async function () {
        return { id: 5, name: 'SSC Officer', email: 'officer@example.com', role: 'ssc-officer', mustChangePassword: true };
      },
    },
  });
  const temporaryLogin = await temporaryEnv.loginWithCredentials('officer@example.com', 'temporary1');
  ok('temporary-password login succeeds', temporaryLogin === true);
  ok('temporary flag is stored in the session', temporaryEnv.getCurrentUser().mustChangePassword === true);
  ok('temporary login skips hydration', temporaryEnv.hydrated === 0);
  ok('temporary login routes to password change', /change-password\.html$/.test(temporaryEnv.window.location.href), temporaryEnv.window.location.href);

  /* ── Local credential helpers and bootstrap are gone ─────────── */

  ok('no local password comparison remains in auth.js', !/passwordMatches\(/.test(authSource));
  ok('no local admin bootstrap remains in auth.js', !/createAdminAccount|firstRunForm/.test(authSource));
  ok('signup calls the API helper', /api\.registerStudent\(payload\)/.test(authSource));
  ok('login calls the API helper', /api\.login\(email, password\)/.test(authSource));
  ok('change page posts to the API', /api\.changePassword\(current, next\)/.test(authSource));
  ok('change page guards through /auth/me', /api\.me\(\)/.test(authSource));
  ok('register helper posts to /auth/register', /registerStudent: function/.test(apiSource) && /\/auth\/register/.test(apiSource));

  /* ── Page contracts ──────────────────────────────────────────── */

  ok('login page drops the local setup form', !/firstRunForm|firstRunPanel/.test(loginHtml));
  ok('pageUrl has a change-password target', /case 'change-password': return P \+ 'change-password\.html'/.test(authSource));
  ok('change page loads the auth controller', /js\/auth\.js/.test(changeHtml));
  ok('change page has all three password fields',
    ['change-current-password-field', 'change-new-password-field', 'change-confirm-password-field']
      .every(id => changeHtml.includes('id="' + id + '"')));
  ok('change page has an error surface', /id="changePasswordError"/.test(changeHtml));
  ok('change page has a sign-out escape', /id="changePasswordLogout"/.test(changeHtml));
  ok('loading note can be hidden', /\.auth-setup-note\[hidden\]/.test(authCss));

  const signupFields = [
    'signup-first-name-field',
    'signup-last-name-field',
    'signup-student-id-field',
    'signup-email-field',
    'signupDepartment',
    'signupCourse',
    'signupYear',
    'signup-block-field',
    'signup-password-field',
    'signup-confirm-field',
    'signup-terms',
  ];
  for (const id of signupFields) {
    ok(`signup form has ${id}`, signupHtml.includes('id="' + id + '"'));
  }
  ok('signup form has the pending panel', /id="signupPendingPanel"/.test(signupHtml));
  ok('signup no longer asks for one full-name field', !/id="signup-name-field"/.test(signupHtml));

  /* ── Report ───────────────────────────────────────────────────── */

  if (failures.length === 0) {
    console.log(`  ${pass} auth-flow assertions passed`);
    process.exit(0);
  }
  console.log(`  ${pass} passed, ${failures.length} FAILED:`);
  for (const failure of failures) console.log('    - ' + failure);
  process.exit(1);
})();

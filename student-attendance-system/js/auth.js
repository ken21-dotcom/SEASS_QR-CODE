/* ============================================================
   Authentication — login, signup, password change, session guard
   ------------------------------------------------------------
   Credentials are verified only by the PHP backend. There is no
   localStorage fallback: if the server is unreachable the auth
   screens report it and stop. Successful logins hydrate the local
   cache before entering a dashboard; new student accounts stay
   pending until an administrator approves them.
   ============================================================ */

/**
 * Resolve the app's root folder from this script's own location.
 * auth.js is always loaded as "<app-root>/js/auth.js", regardless of
 * which subfolder the host page lives in — so the app root is simply
 * the script's path with "/js/auth.js" stripped off. This keeps page
 * redirects working now that role pages live in subfolders.
 * @type {string} trailing-slash app root, e.g. ".../student-attendance-system/"
 */
var APP_BASE = (function () {
  var scripts = document.getElementsByTagName('script');
  var src = '';
  for (var i = scripts.length - 1; i >= 0; i--) {
    if (/\/js\/(auth|data)\.js$/.test(scripts[i].src)) { src = scripts[i].src; break; }
  }
  if (!src) src = scripts[scripts.length - 1] ? scripts[scripts.length - 1].src : '';
  return src.slice(0, src.lastIndexOf('/js/')) + '/';
})();

/**
 * Absolute URL of a key page inside the app. Role pages were
 * reorganised into subfolders, so each dashboard lives one level
 * under pages/. login and kiosk stay at the pages root.
 * @param {'login'|'change-password'|'student'|'ssc-officer'|'admin'} role
 * @returns {string}
 */
function pageUrl(role) {
  var P = APP_BASE + 'pages/';
  switch (role) {
    case 'login':           return P + 'login.html';
    case 'change-password': return P + 'change-password.html';
    case 'student':         return P + 'student/student-dashboard.html';
    case 'ssc-officer':     return P + 'ssc-officer/ssc-dashboard.html';
    case 'admin':           return P + 'administrator/admin-dashboard.html';
    default:                return P + 'login.html';
  }
}

/**
 * Destroy the current session and return to the login page.
 * Called from every page's "Log out" button. When the backend is
 * configured the server session is ended too, though the local
 * redirect never waits on it.
 */
async function logout() {
  if (API_BASE_URL) {
    await api.logout();
  }
  clearAllAppData();
  initStorage();
  window.location.href = pageUrl('login');
}

/**
 * Guard that ensures the current user is authenticated and
 * optionally has the required role. Redirects to the
 * appropriate page when the check fails.
 *
 * @param {string|string[]|null} role — allowed role(s); null = any
 * @returns {object|null} the current user, or null on redirect
 */
function requireAuth(role = null) {
  const user = getCurrentUser();
  if (!user) {
    window.location.href = pageUrl('login');
    return null;
  }

  // A temporary password must be replaced before any dashboard renders.
  if (user.mustChangePassword === true) {
    window.location.href = pageUrl('change-password');
    return null;
  }

  const roleAllowed = Array.isArray(role)
    ? role.includes(user.role)
    : user.role === role;

  if (role && !roleAllowed) {
    switch (user.role) {
      case 'student':     window.location.href = pageUrl('student'); break;
      case 'ssc-officer': window.location.href = pageUrl('ssc-officer'); break;
      case 'admin':       window.location.href = pageUrl('admin'); break;
      default:            window.location.href = pageUrl('login');
    }
    return null;
  }
  return user;
}

/** Confirm cached page identity against the PHP session before rendering data. */
async function requireServerAuth(role) {
  var cached = requireAuth(role);
  if (!cached) return null;
  if (!isApiEnabled()) return cached;

  try {
    var response = await api.me();
    var user = response && Object.prototype.hasOwnProperty.call(response, 'user')
      ? response.user
      : response;
    if (!user || !user.id || !user.role) throw new Error('Your server session has expired. Sign in again.');
    if (user.mustChangePassword === true) {
      window.location.href = pageUrl('change-password');
      return null;
    }
    if (user.role !== role) {
      window.location.href = pageUrl(user.role);
      return null;
    }
    setSession(user);
    return user;
  } catch (error) {
    clearAllAppData();
    initStorage();
    window.location.href = pageUrl('login');
    return null;
  }
}

/**
 * Disable a form's submit button while an async request is in flight.
 * @param {HTMLFormElement|null} form
 * @param {boolean} busy
 * @param {string} [busyLabel]
 */
function setFormBusy(form, busy, busyLabel) {
  if (!form) return;
  form.setAttribute('aria-busy', busy ? 'true' : 'false');

  const button = form.querySelector('button[type="submit"]');
  if (!button) return;

  if (busy) {
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent.trim();
    button.disabled = true;
    button.textContent = busyLabel || 'Please wait...';
    return;
  }

  button.disabled = false;
  if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
}

/**
 * Complete a successful login: cache identity, route to the password
 * change screen when required, otherwise hydrate and enter the role page.
 *
 * @param {object} user safe user returned by POST /auth/login
 */
async function finishLogin(user) {
  // Never carry cached records from a previous account into a new session.
  clearAllAppData();
  initStorage();

  // Cache the safe user record so role pages can render immediately;
  // the authoritative session lives in the PHP cookie.
  setSession(user);

  if (user.mustChangePassword === true) {
    showToast('info', 'Change your temporary password to continue.');
    setTimeout(function () {
      window.location.href = pageUrl('change-password');
    }, 500);
    return;
  }

  // Pull the database's data into the localStorage cache the pages read.
  // Failed collections remain empty rather than exposing another account's
  // stale browser cache as though it belonged to this user.
  const hydration = await hydrateFromApi();
  if (hydration.failed.length) {
    showToast('error', 'Could not load from the server: ' + hydration.failed.join(', ') +
      '. Some pages may be incomplete until the server is available.');
  }

  showToast('success', 'Login successful! Redirecting...');
  setTimeout(function () {
    window.location.href = pageUrl(user.role);
  }, 700);
}

/**
 * Validate credentials against the backend and redirect on success.
 * There is deliberately no local credential fallback.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<boolean>} true when the server accepted the login
 */
async function loginWithCredentials(email, password) {
  var domAvailable = typeof document !== 'undefined'
    && typeof document.getElementById === 'function';

  function clearLoginInlineErrors() {
    if (!domAvailable) return;
    var emailField = document.getElementById('login-email-field');
    var passwordField = document.getElementById('login-password-field');
    var emailFeedback = document.getElementById('login-email-error');
    var passwordFeedback = document.getElementById('login-password-error');
    [emailField, passwordField].forEach(function (field) {
      if (!field) return;
      field.classList.remove('is-invalid');
      field.removeAttribute('aria-invalid');
    });
    [emailFeedback, passwordFeedback].forEach(function (feedback) {
      if (!feedback) return;
      feedback.style.display = 'none';
    });
    if (emailFeedback) emailFeedback.textContent = 'Please enter your email.';
    if (passwordFeedback) passwordFeedback.textContent = 'Please enter your password.';
  }

  if (domAvailable) {
    clearLoginInlineErrors();
    var loginEmailField = document.getElementById('login-email-field');
    var loginPasswordField = document.getElementById('login-password-field');
    var emptyEmail = !String(email || '').trim();
    var emptyPassword = !String(password || '').trim();

    if (emptyEmail) {
      if (typeof setInlineFieldError === 'function') {
        setInlineFieldError(loginEmailField, 'Please enter your email.');
      } else {
        loginEmailField.classList.add('is-invalid');
        var emailFeedback = document.getElementById('login-email-error');
        if (emailFeedback) emailFeedback.textContent = 'Please enter your email.';
      }
    }
    if (emptyPassword) {
      if (typeof setInlineFieldError === 'function') {
        setInlineFieldError(loginPasswordField, 'Please enter your password.');
      } else {
        loginPasswordField.classList.add('is-invalid');
        var passwordFeedback = document.getElementById('login-password-error');
        if (passwordFeedback) passwordFeedback.textContent = 'Please enter your password.';
      }
    }
    if (emptyEmail || emptyPassword) {
      var firstLoginInvalid = document.querySelector('#loginForm .is-invalid');
      if (firstLoginInvalid && firstLoginInvalid.focus) firstLoginInvalid.focus();
      return false;
    }
  }
  if (!isApiEnabled()) {
    showToast('error', 'The server is not configured. Set API_BASE_URL in js/api.js.');
    return false;
  }

  let user;
  try {
    user = await api.login(email, password);
  } catch (error) {
    var loginCode = error && error.code;
    var loginMessage = error && error.message ? error.message : '';
    var specialLoginError = loginCode === 'account_pending' || loginCode === 'pending' || loginCode === 'pending_approval'
      || loginCode === 'account_deactivated' || loginCode === 'network_error'
      || loginMessage === 'Cannot reach the server' || /awaiting administrator approval/i.test(loginMessage);
    var invalidCredentials = loginCode === 'invalid_credentials'
      || loginCode === 'invalid_login' || error.status === 401;
    if (invalidCredentials && domAvailable) {
      clearLoginInlineErrors();
      var loginEmail = document.getElementById('login-email-field');
      var loginPassword = document.getElementById('login-password-field');
      var passwordFeedback = document.getElementById('login-password-error');
      [loginEmail, loginPassword].forEach(function (field) {
        if (!field) return;
        field.classList.add('is-invalid');
        field.setAttribute('aria-invalid', 'true');
      });
      if (passwordFeedback) {
        passwordFeedback.textContent = 'Invalid email or password.';
        passwordFeedback.style.display = 'block';
      }
    } else if (specialLoginError) {
      showToast('error', loginMessage || 'Sign in failed. Please try again.');
    } else if (domAvailable) {
      clearLoginInlineErrors();
      var fallbackPassword = document.getElementById('login-password-error');
      var fallbackPasswordField = document.getElementById('login-password-field');
      if (fallbackPasswordField) fallbackPasswordField.classList.add('is-invalid');
      if (fallbackPassword) {
        fallbackPassword.textContent = loginMessage || 'Sign in failed. Please try again.';
        fallbackPassword.style.display = 'block';
      }
    }
    return false;
  }

  await finishLogin(user);
  return true;
}


/* ============================================================
   Account registration — the sign-up page
   ------------------------------------------------------------
   Self-registration creates pending student accounts only. Officer
   and administrator accounts are issued by an administrator, so
   there is deliberately no role choice here. The endpoint never
   starts a session: an administrator must approve the account
   before the student can sign in.
   ============================================================ */

/** Minimum password length accepted at sign-up. */
var SIGNUP_PASSWORD_MIN = 8;

/** Shared helper and labels for the two password strength meters. */
var PASSWORD_HELPER_TEXT = '8+ characters required with a letter and number';
var PASSWORD_STRENGTH_LABELS = [
  PASSWORD_HELPER_TEXT,
  'Too short',
  'Weak',
  'Fair',
  'Strong',
];

/**
 * Score a password 0–4 for the strength meter.
 * 0 is empty, 1 is below the length floor, and 2–4 count how many of
 * the four character classes (lower, upper, digit, symbol) are present.
 *
 * @param {string} value
 * @returns {number} 0–4
 */
function scorePassword(value) {
  if (!value) return 0;
  if (value.length < SIGNUP_PASSWORD_MIN) return 1;

  var classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/\d/.test(value)) classes++;
  if (/[^A-Za-z0-9]/.test(value)) classes++;

  return Math.min(4, 1 + classes);
}

/**
 * Submit a student account for administrator approval.
 * No session is created and nothing is written to localStorage.
 *
 * @param {{firstName: string, lastName: string, studentIdNumber: string,
 *          email: string, password: string, department: string,
 *          program: string, yearLevel: string, block: string}} details
 * @returns {Promise<object|false>} response object when the server accepted the registration, false on error
 */
async function registerAccount(details) {
  var domAvailable = typeof document !== 'undefined'
    && typeof document.getElementById === 'function';
  if (domAvailable && document.getElementById('signupForm')) {
    var signupValidation = function (id, value, message, feedbackId) {
      var field = document.getElementById(id);
      if (!field) return true;
      if (!String(value || '').trim()) {
        field.classList.add('is-invalid');
        field.setAttribute('aria-invalid', 'true');
        var feedback = document.getElementById(feedbackId);
        if (feedback) feedback.textContent = message;
        return false;
      }
      field.classList.remove('is-invalid');
      return true;
    };
    var confirmPassword = document.getElementById('signup-confirm-field');
    var validationResults = [
      signupValidation('signup-first-name-field', details.firstName, 'First name is required.', 'signup-first-name-error'),
      signupValidation('signup-last-name-field', details.lastName, 'Last name is required.', 'signup-last-name-error'),
      signupValidation('signup-email-field', details.email, 'Please enter a valid email address.', 'signup-email-error'),
      signupValidation('signup-student-id-field', details.studentIdNumber, 'Student ID number is required.', 'signup-student-id-error'),
      signupValidation('signup-block-field', details.block, 'Block is required.', 'signup-block-error'),
      signupValidation('signupDepartment', details.department, 'Please select your department.', 'signupDepartment-error'),
      signupValidation('signupCourse', details.program, 'Please select your course or program.', 'signupCourse-error'),
      signupValidation('signupYear', details.yearLevel, 'Please select your year level.', 'signupYear-error'),
      signupValidation('signup-password-field', details.password, 'Password must be at least 8 characters.', 'signup-password-error'),
      signupValidation('signup-confirm-field', confirmPassword && confirmPassword.value, 'Confirm password is required.', 'signup-confirm-error')
    ];
    var emailField = document.getElementById('signup-email-field');
    var emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(details.email || '').trim());
    if (emailField && !emailValid) {
      emailField.classList.add('is-invalid');
      emailField.setAttribute('aria-invalid', 'true');
      var emailError = document.getElementById('signup-email-error');
      if (emailError) emailError.textContent = 'Please enter a valid email address.';
      validationResults.push(false);
    }
    var termsField = document.getElementById('signup-terms');
    if (termsField && !details.acceptTerms) {
      termsField.classList.add('is-invalid');
      termsField.setAttribute('aria-invalid', 'true');
      validationResults.push(false);
    } else if (termsField) {
      termsField.classList.remove('is-invalid');
      termsField.removeAttribute('aria-invalid');
    }
    var passwordField = document.getElementById('signup-password-field');
    var passwordValid = String(details.password || '').length >= 8;
    if (passwordField && !passwordValid) {
      passwordField.classList.add('is-invalid');
      var passwordError = document.getElementById('signup-password-error');
      if (passwordError) passwordError.textContent = 'Password must be at least 8 characters.';
      validationResults.push(false);
    }
    if (confirmPassword && confirmPassword.value !== String(details.password || '') && String(confirmPassword.value || '').trim()) {
      confirmPassword.classList.add('is-invalid');
      confirmPassword.setAttribute('aria-invalid', 'true');
      var confirmError = document.getElementById('signup-confirm-error');
      if (confirmError) confirmError.textContent = 'Passwords do not match.';
      validationResults.push(false);
    }
    if (validationResults.indexOf(false) !== -1) {
      var firstSignupInvalid = document.querySelector('#signupForm .is-invalid');
      if (firstSignupInvalid && firstSignupInvalid.focus) firstSignupInvalid.focus();
      return false;
    }
  }
  if (!isApiEnabled()) {
    showToast('error', 'The server is not configured. Set API_BASE_URL in js/api.js.');
    return false;
  }

  var org = normalizeStudentOrg({
    department: details.department,
    program: details.program,
    yearLevel: details.yearLevel,
  });
  var payload = {
    firstName:       String(details.firstName || '').trim(),
    lastName:        String(details.lastName || '').trim(),
    studentIdNumber: String(details.studentIdNumber || '').trim(),
    email:           String(details.email || '').trim().toLowerCase(),
    password:        String(details.password || ''),
    department:      org.department === UNASSIGNED ? '' : org.department,
    program:         org.course === UNASSIGNED ? '' : org.course,
    yearLevel:       String(details.yearLevel || '').trim(),
    block:           String(details.block || '').trim(),
  };

  try {
    var response = await api.registerStudent(payload);
    var registrationAccepted = response && response.ok === true
      && (response.role === 'student' || response.message === 'OTP Sent');
    if (!registrationAccepted) return false;

    // Registration succeeds before account approval; move the same page from
    // the sign-up fields to the OTP card instead of navigating away.
    if (typeof document.getElementById !== 'function') return response;

    var signupFormElement = document.getElementById('signupForm');
    var otpVerificationPanel = document.getElementById('otpVerificationPanel');
    var otpEmailDisplay = document.getElementById('otpEmailDisplay');
    var signupFormTitle = document.getElementById('signupFormTitle');
    var signupFormSubtitle = document.getElementById('signupFormSubtitle');

    if (signupFormElement) {
      signupFormElement.style.display = 'none';
      signupFormElement.hidden = true;
    }
    if (otpEmailDisplay) otpEmailDisplay.textContent = payload.email;
    if (otpVerificationPanel) {
      otpVerificationPanel.classList.remove('d-none');
      otpVerificationPanel.hidden = false;
      otpVerificationPanel.focus();
    }
    if (signupFormTitle) signupFormTitle.textContent = 'Verify your email';
    if (signupFormSubtitle) signupFormSubtitle.textContent = 'Enter the 6-digit code sent to your email.';

    // Registration completed successfully, so remove stale validation errors.
    document.querySelectorAll('.toast.bg-danger, .toast.text-bg-danger, .toast-error, .auth-form-error').forEach(function (element) {
      element.remove();
    });
    document.querySelectorAll('#signupForm .is-invalid').forEach(function (element) {
      element.classList.remove('is-invalid');
    });

    return response;
  } catch (error) {
    // Duplicate email/student ID conflicts are returned as a 409 from the
    // server. Keep a useful message even if a proxy or older backend omits it.
    var message = error && error.message;
    if (error && error.code === 'duplicate' && !message) {
      message = 'That email or student ID number is already registered.';
    }
    var normalized = String(message || '').toLowerCase();
    var emailField = typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('signup-email-field') : null;
    var studentIdField = typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('signup-student-id-field') : null;
    if (((error && error.code === 'duplicate_email') || normalized.includes('email already registered') || normalized.includes('email is already'))) {
      if (typeof setInlineFieldError === 'function') {
        setInlineFieldError(emailField, 'This email is already registered.');
      }
    } else if (((error && error.code === 'duplicate_student_id') || normalized.includes('student id') || normalized.includes('student id number'))) {
      if (typeof setInlineFieldError === 'function') {
        setInlineFieldError(studentIdField, 'This Student ID is already in use.');
      }
    } else if (typeof showToast === 'function') {
      showToast('error', message || 'Could not submit your registration. Please try again.');
    }
    return false;
  }
}


/**
 * Verify the OTP sent to a pending student's email.
 * @param {string} email
 * @param {string} otp
 * @returns {Promise<object|false>} response object on success, false on error
 */
async function verifyOtp(email, otp) {
  if (!isApiEnabled()) {
    showToast('error', 'The server is not configured. Set API_BASE_URL in js/api.js.');
    return false;
  }

  try {
    var response = await api.verifyOtp(email, otp);
    return response;
  } catch (error) {
    var message = error && error.message;
    if (error && error.code === 'invalid_otp' && !message) {
      message = 'Invalid verification code.';
    } else if (error && error.code === 'otp_expired' && !message) {
      message = 'Verification code has expired. Please register again.';
    }
    var otpField = typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('otp-field') : null;
    if (typeof setInlineFieldError === 'function') {
      setInlineFieldError(otpField, 'Invalid or expired code. Please try again.');
    }
    return false;
  }
}


/* ============================================================
   Forced password change — temporary officer/admin passwords
   ------------------------------------------------------------
   GET /auth/me decides whether this page may stay open. A user
   with mustChangePassword=false is already done, and a null user
   is sent back to sign in. POST /auth/password is the only
   authenticated endpoint allowed while the flag is set.
   ============================================================ */

/**
 * Wire the change-password page.
 * @param {HTMLFormElement} form
 */
function initChangePasswordPage(form) {
  const loading       = document.getElementById('changePasswordLoading');
  const loadError     = document.getElementById('changePasswordLoadError');
  const formError     = document.getElementById('changePasswordError');
  const accountLabel  = document.getElementById('changePasswordAccount');
  const currentField  = document.getElementById('change-current-password-field');
  const newField      = document.getElementById('change-new-password-field');
  const confirmField  = document.getElementById('change-confirm-password-field');
  const meter         = document.getElementById('changeStrength');
  const meterLabel    = document.getElementById('changeStrengthLabel');
  const logoutButton  = document.getElementById('changePasswordLogout');

  var currentUser = null;

  function setError(message) {
    if (!formError) return;
    formError.textContent = message || '';
    formError.hidden = !message;
  }

  function setFieldState(field, ok) {
    if (field) field.classList.toggle('is-invalid', !ok);
  }

  function updateStrengthMeter() {
    if (!meter || !meterLabel) return;
    const level = scorePassword(newField.value);
    meter.dataset.level = String(level);
    meterLabel.textContent = PASSWORD_STRENGTH_LABELS[level];
  }

  function showForm(user) {
    if (loading) loading.hidden = true;
    if (accountLabel) {
      accountLabel.textContent = user.name
        ? user.name + ' · ' + user.email
        : user.email;
    }
    form.hidden = false;
    updateStrengthMeter();
    currentField.focus();
  }

  async function loadUser() {
    try {
      const result = await api.me();
      const user = result && Object.prototype.hasOwnProperty.call(result, 'user')
        ? result.user
        : result;

      if (!user) {
        clearSession();
        window.location.replace(pageUrl('login'));
        return;
      }

      setSession(user);

      if (user.mustChangePassword !== true) {
        window.location.replace(pageUrl(user.role));
        return;
      }

      currentUser = user;
      showForm(user);
    } catch (error) {
      if (error.status === 401) {
        clearSession();
        window.location.replace(pageUrl('login'));
        return;
      }
      if (loadError) {
        loadError.textContent = error.message || 'Could not check your session. Try again.';
        loadError.hidden = false;
      }
    }
  }

  if (logoutButton) {
    logoutButton.addEventListener('click', function (e) {
      e.preventDefault();
      logout();
    });
  }

  newField.addEventListener('input', function () {
    updateStrengthMeter();
    if (confirmField.classList.contains('is-invalid')) {
      setFieldState(confirmField, confirmField.value === newField.value);
    }
  });

  confirmField.addEventListener('input', function () {
    if (confirmField.classList.contains('is-invalid')) {
      setFieldState(confirmField, confirmField.value === newField.value);
    }
  });

  currentField.addEventListener('input', function () {
    if (currentField.classList.contains('is-invalid')) {
      setFieldState(currentField, currentField.value.length > 0);
    }
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    setError('');

    const current = currentField.value;
    const next    = newField.value;
    const confirm = confirmField.value;

    const currentOk = current.length > 0;
    const newOk     = scorePassword(next) >= 2 && next !== current;
    const confirmOk = confirm.length > 0 && confirm === next;

    setFieldState(currentField, currentOk);
    setFieldState(newField, newOk);
    setFieldState(confirmField, confirmOk);

    const firstInvalid = form.querySelector('.is-invalid');
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    setFormBusy(form, true, 'Updating...');

    try {
      await api.changePassword(current, next);

      var updated = null;
      try {
        const result = await api.me();
        updated = result && Object.prototype.hasOwnProperty.call(result, 'user')
          ? result.user
          : result;
      } catch (ignored) {
        // The password change succeeded; refresh identity best-effort.
      }

      setSession(updated || Object.assign({}, currentUser, { mustChangePassword: false }));

      const hydration = await hydrateFromApi();
      if (hydration.failed.length) {
        showToast('error', 'Could not load from the server: ' + hydration.failed.join(', ') +
          '. Showing locally cached data for those.');
      }

      showToast('success', 'Password updated. Redirecting...');
      setTimeout(function () {
        window.location.href = pageUrl((updated || currentUser).role);
      }, 700);
    } catch (error) {
      setFormBusy(form, false);

      if (error.code === 'unauthenticated') {
        clearSession();
        window.location.replace(pageUrl('login'));
        return;
      }

      if (error.code === 'invalid_credentials') {
        setFieldState(currentField, false);
        currentField.focus();
      }

      setError(error.message || 'Could not update your password.');
    }
  });

  loadUser();
}


/* ============================================================
   DOMContentLoaded — login, sign-up and password change pages
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {

  // ── Already signed in? Skip the auth screens. ──
  // Without this, a signed-in user can sign up again and silently create
  // a second account while a session is already open for the first one.
  const signupForm = document.getElementById('signupForm');
  if (signupForm) {
    const signedIn = getCurrentUser();
    if (signedIn) {
      window.location.replace(pageUrl(
        signedIn.mustChangePassword === true ? 'change-password' : signedIn.role
      ));
      return;
    }
  }

  // ── Login form submission ──
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      const emailField = document.getElementById('login-email-field');
      const passwordField = document.getElementById('login-password-field');
      [emailField, passwordField].forEach(function (field) {
        if (!field) return;
        field.classList.remove('is-invalid');
        field.removeAttribute('aria-invalid');
      });
      ['login-email-error', 'login-password-error'].forEach(function (id) {
        var feedback = document.getElementById(id);
        if (feedback) feedback.style.display = 'none';
      });
      [emailField, passwordField].forEach(function (field) {
        if (!field) return;
        field.addEventListener('input', function () {
          [emailField, passwordField].forEach(function (loginField) {
            if (!loginField) return;
            loginField.classList.remove('is-invalid');
            loginField.removeAttribute('aria-invalid');
          });
          ['login-email-error', 'login-password-error'].forEach(function (id) {
            var feedback = document.getElementById(id);
            if (feedback) feedback.style.display = 'none';
          });
        }, { once: true });
      });
      const email    = emailField.value.trim();
      // Passwords are opaque credentials: leading or trailing whitespace may
      // be intentional and must be sent exactly as the user entered it.
      const password = document.getElementById('login-password-field').value;

      setFormBusy(loginForm, true, 'Signing in...');
      const accepted = await loginWithCredentials(email, password);
      if (!accepted) setFormBusy(loginForm, false);
    });
  }

  // ── Forced password change ──
  const changePasswordForm = document.getElementById('changePasswordForm');
  if (changePasswordForm) {
    initChangePasswordPage(changePasswordForm);
  }

  // ── Password visibility toggles (eye / eye-slash) ──
  // Wired per .input-group-password group rather than by id, so the sign-up
  // page's two password fields get the same behaviour as the login page's one
  // without duplicating the handler.
  document.querySelectorAll('.input-group-password').forEach(function (group) {
    const field = group.querySelector('input');
    const toggle = group.querySelector('.auth-password-toggle');
    const icon = toggle && toggle.querySelector('i');
    if (!field || !toggle || !icon) return;

    toggle.addEventListener('click', function () {
      const show = field.type === 'password';
      field.type = show ? 'text' : 'password';
      icon.className = show ? 'bi bi-eye-slash' : 'bi bi-eye';
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      toggle.setAttribute('aria-pressed', String(show));

      // Brief "flick" cue — pick up, swap, settle.
      toggle.classList.add('is-switching');
      setTimeout(function () { toggle.classList.remove('is-switching'); }, 160);
    });
  });

  // ── Sign-up page ──
  if (signupForm) {
    const firstNameField = document.getElementById('signup-first-name-field');
    const lastNameField  = document.getElementById('signup-last-name-field');
    const studentIdField = document.getElementById('signup-student-id-field');
    const emailField     = document.getElementById('signup-email-field');
    const departmentField = document.getElementById('signupDepartment');
    const programField   = document.getElementById('signupCourse');
    const yearField      = document.getElementById('signupYear');
    const blockField     = document.getElementById('signup-block-field');
    const passwordField  = document.getElementById('signup-password-field');
    const confirmField   = document.getElementById('signup-confirm-field');
    const termsBox       = document.getElementById('signup-terms');
    const meter          = document.getElementById('signupStrength');
    const meterLabel     = document.getElementById('signupStrengthLabel');
    const pendingPanel   = document.getElementById('signupPendingPanel');
    const otpPanel       = document.getElementById('otpVerificationPanel') || document.getElementById('signupOtpPanel');
    const otpForm        = document.getElementById('otpForm');
    const otpField       = document.getElementById('otp-field');
    const otpEmailDisplay = document.getElementById('otpEmailDisplay');
    const formTitle      = document.getElementById('signupFormTitle');
    const formSubtitle   = document.getElementById('signupFormSubtitle');

    // Reuse the shared department → course → year cascade from ui.js, so
    // sign-up offers exactly the taxonomy the student lists group by.
    initOrgModalSelects('signupDepartment', 'signupCourse', 'signupYear', null, { includeUnassigned: false });

    const textFields = [firstNameField, lastNameField, studentIdField, blockField];

    function isEmailValid() {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailField.value.trim());
    }

    function updateStrengthMeter() {
      const level = scorePassword(passwordField.value);
      meter.dataset.level = String(level);
      meterLabel.textContent = PASSWORD_STRENGTH_LABELS[level];
    }

    function setFieldState(field, ok) {
      if (!field) return;
      field.classList.toggle('is-invalid', !ok);
    }

    function revalidate(field, isValid) {
      if (field.classList.contains('is-invalid')) setFieldState(field, isValid());
    }

    textFields.forEach(function (field) {
      field.addEventListener('blur', function () {
        setFieldState(field, field.value.trim().length > 0);
      });
      field.addEventListener('input', function () {
        revalidate(field, function () { return field.value.trim().length > 0; });
      });
    });

    [departmentField, programField, yearField].forEach(function (field) {
      field.addEventListener('change', function () {
        revalidate(field, function () { return field.value.trim().length > 0; });
      });
    });

    emailField.addEventListener('blur', function () {
      setFieldState(emailField, isEmailValid());
    });
    emailField.addEventListener('input', function () {
      revalidate(emailField, isEmailValid);
    });

    passwordField.addEventListener('blur', function () {
      setFieldState(passwordField, scorePassword(passwordField.value) >= 2);
    });
    passwordField.addEventListener('input', function () {
      updateStrengthMeter();
      revalidate(passwordField, function () {
        return scorePassword(passwordField.value) >= 2;
      });
      revalidate(confirmField, function () {
        return confirmField.value === passwordField.value;
      });
    });

    confirmField.addEventListener('blur', function () {
      setFieldState(confirmField, confirmField.value.length > 0 && confirmField.value === passwordField.value);
    });
    confirmField.addEventListener('input', function () {
      revalidate(confirmField, function () {
        return confirmField.value === passwordField.value;
      });
    });

    termsBox.addEventListener('blur', function () {
      setFieldState(termsBox, termsBox.checked);
    });
    termsBox.addEventListener('change', function () {
      revalidate(termsBox, function () { return termsBox.checked; });
    });

    signupForm.addEventListener('submit', async function (e) {
      e.preventDefault();

      const password = passwordField.value;

      // Validation and inline feedback are owned by registerAccount().
      // The submit handler only gathers values and manages submission state.

      setFormBusy(signupForm, true, 'Submitting...');

      const response = await registerAccount({
        firstName:       firstNameField.value,
        lastName:        lastNameField.value,
        studentIdNumber: studentIdField.value,
        email:           emailField.value,
        password:        password,
        department:      departmentField.value,
        program:         programField.value,
        yearLevel:       yearField.value,
        block:           blockField.value,
        acceptTerms:     termsBox.checked,
      });

      if (!response) {
        setFormBusy(signupForm, false);
        return;
      }

      // Success: show OTP verification panel
      signupForm.hidden = true;
      if (formTitle) formTitle.textContent = 'Verify your email';
      if (formSubtitle) {
        formSubtitle.textContent = 'Enter the 6-digit code sent to your email.';
      }
      if (otpEmailDisplay) otpEmailDisplay.textContent = emailField.value;
      if (otpPanel) {
        otpPanel.classList.remove('d-none');
        otpPanel.hidden = false;
        otpPanel.focus();
      }
      showToast('success', 'Verification code sent. Check your inbox.');
    });

    // OTP form handler
    if (otpForm) {
      otpForm.addEventListener('submit', async function (e) {
        e.preventDefault();

        const otp = otpField.value.trim();
        setFieldState(otpField, otp.length === 6 && /^\d{6}$/.test(otp));

        if (otp.length !== 6 || !/^\d{6}$/.test(otp)) {
          otpField.focus();
          return;
        }

        const submitBtn = otpForm.querySelector('button[type="submit"]');
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Verifying...';
        }

        const response = await verifyOtp(emailField.value, otp);

        if (!response) {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Verify Code';
          }
          return;
        }

        // OTP verified successfully - show pending panel
        otpPanel.hidden = true;
        if (formTitle) formTitle.textContent = 'Account created!';
        if (formSubtitle) {
          formSubtitle.textContent = 'Your email is verified. Waiting for administrator approval.';
        }
        if (pendingPanel) {
          pendingPanel.hidden = false;
          pendingPanel.focus();
        }
        showToast('success', 'Email verified! Awaiting administrator approval.');
      });
    }

    updateStrengthMeter();
  }



  // ── Hero carousel ──
  // Story-style autoplay: one slim progress segment per slide. The active
  // segment's fill animates empty→full over the dwell time (heroProgressFill,
  // 5s linear) and its animationend drives the advance to the next slide, so
  // the JS stays in lock-step with the CSS fill — no timer drift. Finished
  // segments hold solid, upcoming ones show only a dim track, and hovering
  // the hero pauses the current fill in place. Clicks and arrows restart the
  // active segment's fill from empty.
  //
  // Navigation is arrows-only: there is no play/pause control. Autoplay runs
  // normally, but stays still when the user has requested reduced motion.
  (function () {
    const bgSlides      = document.querySelectorAll('.auth-hero-slide');
    const slideContents = document.querySelectorAll('.auth-hero-slide-content');
    const indicators    = document.querySelectorAll('.auth-hero-progress');
    const indicatorsBox = document.querySelector('.auth-hero-indicators');
    const slideNum      = document.querySelector('.auth-hero-slide-num');
    const prevBtn       = document.getElementById('heroPrev');
    const nextBtn       = document.getElementById('heroNext');
    const hero          = document.querySelector('.auth-hero');

    let current    = 0;
    const total    = slideContents.length;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let isPaused   = false; // hover / focus only — there is no manual pause control

    /** Restart a segment's fill so it starts empty again. */
    function restartFill(ind) {
      const fill = ind.querySelector('.auth-hero-progress-fill');
      if (!fill) return;
      fill.style.animation = 'none';
      void fill.offsetWidth; // reflow to restart the animation from 0
      fill.style.animation = '';
    }

    /** Animate the two-digit slide counter instead of replacing its wrapper. */
    function updateSlideNumber(index) {
      if (!slideNum) return;
      const nextValue = String(index + 1).padStart(2, '0');
      const currentNumber = slideNum.querySelector('.auth-hero-slide-num-inner.current');
      if (currentNumber && currentNumber.textContent === nextValue) return;

      slideNum.querySelectorAll('.auth-hero-slide-num-inner:not(.current)').forEach(function (number) {
        number.remove();
      });

      if (reduceMotion) {
        slideNum.innerHTML = `<span class="auth-hero-slide-num-inner current">${nextValue}</span>`;
        return;
      }

      if (currentNumber) {
        currentNumber.classList.remove('current');
        currentNumber.classList.add('exit-up');
      }

      const nextNumber = document.createElement('span');
      nextNumber.className = 'auth-hero-slide-num-inner enter-down';
      nextNumber.textContent = nextValue;
      slideNum.appendChild(nextNumber);

      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          nextNumber.classList.remove('enter-down');
          nextNumber.classList.add('current');
        });
      });

      window.setTimeout(function () {
        if (currentNumber) currentNumber.remove();
      }, 460);
    }

    /**
     * Advance to a specific slide. Wraps around at both ends.
     * @param {number} index
     * @param {boolean} restart — true to reset the autoplay timing
     */
    function goToSlide(index, restart) {
      if (index < 0) index = total - 1;
      if (index >= total) index = 0;

      if (bgSlides[current]) bgSlides[current].classList.remove('active');
      if (slideContents[current]) slideContents[current].classList.remove('active');

      current = index;
      if (bgSlides[current]) bgSlides[current].classList.add('active');
      if (slideContents[current]) slideContents[current].classList.add('active');

      indicators.forEach(function (ind, i) {
        ind.classList.toggle('active', i === current);
        ind.classList.toggle('done', i < current);
        if (i === current) ind.setAttribute('aria-current', 'step');
        else ind.removeAttribute('aria-current');
      });
      if (!reduceMotion) restartFill(indicators[current]);

      updateSlideNumber(current);
      if (restart) startAuto();
    }

    function setPlayState(state) {
      indicators.forEach(function (ind) {
        ind.classList.toggle('paused', state === 'paused');
        ind.classList.toggle('running', state === 'running');
      });
    }

    function startAuto() {
      isPaused = false;
      setPlayState('running');
    }

    function pauseAuto() {
      if (isPaused) return;
      isPaused = true;
      setPlayState('paused');
    }

    function resumeAuto() {
      if (!isPaused) return;
      isPaused = false;
      setPlayState('running');
    }

    // Auto-advance fires when the active segment finishes filling.
    if (indicatorsBox) {
      indicatorsBox.addEventListener('animationend', function (e) {
        if (e.animationName !== 'heroProgressFill') return;
        if (!e.target.closest || !e.target.closest('.auth-hero-progress.active')) return;
        if (isPaused || reduceMotion) return;
        goToSlide(current + 1, true);
      });
    }

    // Indicator click → jump to that slide directly and restart its fill.
    // A brief pop on the target segment makes the jump land smoothly.
    indicators.forEach(function (ind) {
      ind.addEventListener('click', function () {
        const target = parseInt(ind.dataset.slide, 10);
        if (target !== current && !reduceMotion) {
          ind.classList.add('pop');
          setTimeout(function () { ind.classList.remove('pop'); }, 300);
        }
        goToSlide(target, true);
      });
    });

    // Arrow buttons — reset the active segment's fill via goToSlide(restart)
    if (prevBtn) prevBtn.addEventListener('click', function () { goToSlide(current - 1, true); });
    if (nextBtn) nextBtn.addEventListener('click', function () { goToSlide(current + 1, true); });

    // Pause autoplay while hovering the hero so it doesn't fight manual
    // navigation. Autoplay resumes on leave — there is no manual pause control.
    if (hero) {
      hero.addEventListener('mouseenter', pauseAuto);
      hero.addEventListener('mouseleave', resumeAuto);
      hero.addEventListener('focusin', pauseAuto);
      hero.addEventListener('focusout', function (event) {
        if (!hero.contains(event.relatedTarget)) resumeAuto();
      });
    }

    goToSlide(current, true);
  })();
});

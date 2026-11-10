/* ============================================================
   API Client
   ------------------------------------------------------------
   The single place the frontend talks to the PHP backend. Every
   call goes through request(); nothing else uses fetch().

   Authentication requires the backend. The rest of the app still
   reads through the localStorage cache that hydrateFromApi() fills
   after a successful login.

   To run it:

      1. Start it:   php -S localhost:8000 -t public router.php
                    (from the attendly-backend directory)
      2. Allow the frontend origin in config/config.php:
                    'cors' => ['allowed_origin' => 'http://localhost:5173']
      3. Serve this folder on port 5173 (see package.json).
   ============================================================ */

/* eslint-env browser */

/* ── What is and is not synced ─────────────────────────────────────
 *
 * Reading is fully wired; writing is only wired where the form actually
 * collects the data the endpoint requires.
 *
 *   Read  (hydrateFromApi, on login)
 *     users, events, attendance ... synced
 *
 *   Write
 *     login / logout / change password ............ synced
 *     student self-registration (pending) ......... synced
 *     event create / update / delete .............. synced
 *     kiosk QR / manual check-in ................. synced; matching is server-side
 *     officer create / status change ............. synced
 *     student profile edit ....................... synced (administrator)
 *     reenrollment requests ....................... synced
 *
 * The local-only entries are not oversights. There are no endpoints for
 * them yet, or the forms do not collect the fields those endpoints would
 * need. Because their mutations are not sent anywhere, a record changed
 * in the browser is not changed for anyone else.
 * ------------------------------------------------------------------ */

/**
 * True when the app is configured to talk to the PHP backend.
 *
 * This reads the configuration, not the last request outcome, so it is
 * still correct on a freshly loaded page — unlike apiOnline, which
 * starts false again on every navigation.
 *
 * @returns {boolean}
 */
function isApiEnabled() {
  return typeof API_BASE_URL === 'string' && API_BASE_URL.trim() !== '';
}

/**
 * Base URL of the JSON API, including the /api mount point. Resolved from
 * the page's own hostname so laptop, 127.0.0.1 and LAN/phone access all
 * stay same-site with the PHP session cookie.
 * @type {string}
 */
/*
 * IMPORTANT: use the page's own hostname for the API host.
 *  - localhost:5173            -> http://localhost:8000/api
 *  - 127.0.0.1:5173            -> http://127.0.0.1:8000/api
 *  - 192.168.x.x:5173 (phone)  -> http://192.168.x.x:8000/api
 *
 * Mapping 127.0.0.1 to "localhost" (or vice versa) would make the request
 * cross-site, and a SameSite=Lax PHP session cookie is not sent cross-site,
 * so login would appear to succeed and every following call would 401.
 */
var API_HOST = typeof window !== 'undefined' && window.location && window.location.hostname
  ? window.location.hostname
  : 'localhost';
var API_BASE_URL = typeof window !== 'undefined' && typeof window.ATTENDLY_API_BASE_URL === 'string'
  ? window.ATTENDLY_API_BASE_URL
  : 'http://' + API_HOST + ':8000/api';

/** True once a backend call has succeeded at least once. */
var apiOnline = false;

/** True once a backend call has failed with a network/CORS error. */
var apiOffline = false;

/**
 * Absolute URL for an API path.
 * @param {string} path e.g. '/events'
 * @returns {string}
 */
function apiUrl(path) {
  if (!API_BASE_URL) return path;
  return API_BASE_URL.replace(/\/+$/, '') + path;
}

/**
 * Perform a JSON request against the API.
 *
 * @param {string} path    e.g. '/events'
 * @param {Object} [options]
 * @param {string} [options.method='GET']
 * @param {Object} [options.body]     JSON request payload
 * @param {boolean} [options.anonymous=false] skip the 401 redirect
 * @returns {Promise<*>} resolves with the `data` field, or the
 *   resolved value of options.validate when it returns false
 * @throws {Error} with .code and .status set on failure
 */
async function request(path, options) {
  var opts = options || {};

  if (!API_BASE_URL) {
    throw new Error('API is not configured');
  }

  var init = {
    method: opts.method || 'GET',
    // Send the PHP session cookie. Requires the backend to echo a
    // matching Access-Control-Allow-Origin (see config/config.php).
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  };

  if (['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(init.method.toUpperCase()) !== -1) {
    init.headers['X-Requested-With'] = 'XMLHttpRequest';
  }

  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  var response;
  try {
    response = await fetch(apiUrl(path), init);
  } catch (networkError) {
    apiOffline = true;
    var offline = new Error('Cannot reach the server. Check that the backend is running.');
    offline.code = 'network_error';
    throw offline;
  }

  var payload = null;
  try {
    payload = await response.json();
  } catch {
    // A non-JSON body means something other than the API answered
    // (a PHP notice, a proxy error page).
    var malformed = new Error('The server returned an unexpected response.');
    malformed.code = 'invalid_response';
    throw malformed;
  }

  if (!response.ok) {
    var detail = payload && payload.error ? payload.error : null;
    var error = new Error(detail ? detail.message : 'Request failed.');
    error.code = detail ? detail.code : 'http_error';
    error.status = response.status;

    // 401 means the PHP session expired. Only bounce to login for
    // calls the user initiated, never for a background probe.
    if (response.status === 401 && !opts.anonymous) {
      redirectToLogin();
    }
    throw error;
  }

  apiOnline = true;
  apiOffline = false;

  var data = payload && Object.prototype.hasOwnProperty.call(payload, 'data')
    ? payload.data
    : payload;

  if (typeof opts.validate === 'function' && !opts.validate(data)) {
    var invalid = new Error('The server response was missing required fields.');
    invalid.code = 'invalid_response';
    throw invalid;
  }

  return data;
}

/**
 * Send the browser to the login page, preserving where the user was.
 * Defined in auth.js; guarded because the kiosk does not load auth.js —
 * it keeps its own lock overlay instead of navigating away.
 */
function redirectToLogin() {
  if (typeof clearSession === 'function') clearSession();
  if (typeof pageUrl === 'function') {
    window.location.href = pageUrl('login');
  }
}

/**
 * Whether the app should read through the backend.
 *
 * True only when a base URL is configured and the backend answered a
 * health check. Until then the prototype keeps using localStorage.
 * @returns {Promise<boolean>}
 */
async function useRemoteData() {
  if (!API_BASE_URL) return false;
  try {
    var health = await request('/health', { anonymous: true });
    return !!health && health.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Prime the localStorage cache from the backend.
 *
 * Every page reads its data through synchronous accessors such as
 * getEvents(), so rather than converting all of them to async this pulls
 * the collections the API can serve into the same keys the accessors read.
 * A page load after login therefore behaves identically whether the data
 * came from the database or from the seed data.
 *
 * Deliberately never throws: a partial backend must not block sign-in.
 * The return value lets the caller report what did not load, because
 * silently serving demo data as though it were real data is the one
 * failure mode worth surfacing.
 *
 * @returns {Promise<{synced: string[], failed: string[]}>}
 */
async function hydrateFromApi() {
  var result = { synced: [], failed: [] };
  if (!isApiEnabled()) return result;

  // Sequential on purpose: these share one PHP session, and a 401 mid-run
  // should surface as a clean failure rather than five parallel redirects.
  var jobs = [
    ['users', function () { return api.listUsers(); }, 'setUsers'],
    ['events', function () { return api.listEvents(); }, 'setEvents'],
    ['announcements', function () { return api.listAnnouncements(); }, 'setAnnouncements'],
    ['attendance', function () { return api.listAttendance(); }, 'setAttendance'],
    ['sanctions', function () { return api.listSanctions(); }, 'setSanctions'],
    ['reenrollment requests', function () { return api.listReenrollmentRequests(); }, 'setReenrollmentRequests'],
    ['audit logs', function () { return api.listAuditLogs(50); }, 'setAuditLogs'],
  ];

  // /reports/sanctions and /audit-logs are staff-only. Requesting them as a
  // student is a guaranteed 403, which used to surface as a login error toast
  // even though every student-readable collection had synced correctly.
  var viewer = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
  if (viewer && viewer.role === 'student') {
    jobs = jobs.filter(function (job) {
      return job[0] !== 'sanctions' && job[0] !== 'audit logs';
    });
  }

  for (var i = 0; i < jobs.length; i++) {
    var name = jobs[i][0];
    try {
      var rows = await jobs[i][1]();
      if (!Array.isArray(rows)) throw new Error('expected a list');
      // Resolved by name at call time: data.js is not loaded when this
      // file is parsed, but it always is by the time we run.
      var store = window[jobs[i][2]];
      if (typeof store !== 'function') throw new Error('accessor missing');
      store(rows);
      // Repair legacy school/program values in the local cache. The same
      // normalization happens on every server read, so this is belt-and-braces.
      if (jobs[i][2] === 'setUsers' && typeof backfillStudentOrg === 'function') {
        backfillStudentOrg();
      }
      result.synced.push(name);
    } catch (err) {
      result.failed.push(name);
    }
  }
  return result;
}

/* ── Endpoint helpers ────────────────────────────────────────── */

/**
 * Add one hour to an 'HH:MM' string, wrapping past midnight.
 * @param {string} hhmm
 * @returns {string}
 */
function addHour(hhmm) {
  var parts = String(hhmm).split(':');
  var minutes = (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0) + 60;
  var hh = Math.floor(minutes / 60) % 24;
  var mm = minutes % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

var api = {
  login: function (email, password) {
    return request('/auth/login', {
      method: 'POST',
      body: { email: email, password: password },
      anonymous: true,
      validate: function (user) {
        return user && user.id && user.role;
      },
    });
  },

  /**
   * Submit a student self-registration. The account is created with
   * pending status and no session, so the caller must not redirect.
   */
  registerStudent: function (student) {
    return request('/auth/register', {
      method: 'POST',
      body: student,
      anonymous: true,
      validate: function (user) {
        return user && user.id && user.role === 'student';
      },
    });
  },

  /**
   * Verify the OTP sent to a pending student's email.
   */
  verifyOtp: function (email, otp) {
    return request('/auth/verify-otp', {
      method: 'POST',
      body: { email: email, otp: otp },
      anonymous: true,
    });
  },

  logout: function () {
    // Always clear locally, even if the server call fails.
    return request('/auth/logout', { method: 'POST', anonymous: true })
      .catch(function () { return { ok: true }; });
  },

  me: function () {
    return request('/auth/me', { anonymous: true });
  },

  changePassword: function (currentPassword, newPassword) {
    // anonymous: a wrong current password is a 401 too, but it must not
    // bounce the user out of the forced-change screen.
    return request('/auth/password', {
      method: 'POST',
      body: { currentPassword: currentPassword, newPassword: newPassword },
      anonymous: true,
    });
  },

  listUsers: function (status, role) {
    var params = [];
    if (status) params.push('status=' + encodeURIComponent(status));
    if (role) params.push('role=' + encodeURIComponent(role));
    var query = params.length ? '?' + params.join('&') : '';
    return request('/users' + query, { validate: Array.isArray });
  },

  updateUserStatus: function (userId, status) {
    return request('/users/' + encodeURIComponent(userId) + '/status', {
      method: 'PATCH',
      body: { status: status },
      validate: function (user) {
        return !!user && user.id !== undefined && !!user.role;
      },
    });
  },

  updateStudentProfile: function (userId, profile) {
    return request('/users/' + encodeURIComponent(userId) + '/profile', {
      method: 'PATCH',
      body: profile,
      validate: function (user) { return !!user && user.id !== undefined && user.role === 'student'; },
    });
  },

  createOfficer: function (officer) {
    return request('/users/officers', {
      method: 'POST',
      body: officer,
      validate: function (user) {
        return !!user && user.id !== undefined && user.role === 'ssc-officer';
      },
    });
  },

  listEvents: function () {
    return request('/events', { validate: Array.isArray });
  },

  listAnnouncements: function () {
    return request('/announcements', { validate: Array.isArray });
  },

  /**
   * Translate a UI event into the API's shape.
   *
   * The event form speaks the dashboard's vocabulary (major/minor,
   * location, a single time) while the schema uses mandatory/optional
   * and venue. Doing the translation in one place keeps the mapper in
   * Repository.php and this function as exact inverses.
   *
   * @param {Object} event a UI event object
   * @param {string} [endTime] 'HH:MM'; defaults to one hour after start
   * @returns {Object} request body for POST/PATCH /events
   */
  toEventPayload: function (event, endTime) {
    var start = event.time || '00:00';
    return {
      name: event.name,
      date: event.date,
      startTime: start,
      endTime: endTime || addHour(start),
      venue: event.location,
      // Mandatory (attendance required) and major/minor (report grouping)
      // are separate fields. Older local events only carry `type`, so fall
      // back to the original inversion when `mandatory` is absent.
      eventType: event.mandatory === true
        ? 'mandatory'
        : (event.type === 'major' ? 'mandatory' : 'optional'),
      eventCategory: event.category || event.type || (event.mandatory === true ? 'major' : 'minor'),
      semester: event.semester || 'N/A',
      targetDepartment: event.targetDepartment || null,
      attendanceType: event.attendanceType || 'single',
      description: event.description || null,
    };
  },

  createEvent: function (event) {
    return request('/events', { method: 'POST', body: api.toEventPayload(event) });
  },

  updateEvent: function (id, payload) {
    return request('/events/' + encodeURIComponent(id), { method: 'PATCH', body: payload });
  },

  deleteEvent: function (id) {
    return request('/events/' + encodeURIComponent(id), { method: 'DELETE' });
  },

  /**
   * Fetch the signed QR token for one student/event pair.
   * The token is scoped to the event; the kiosk must be operating that
   * same event or the server rejects the scan with invalid_qr_event.
   */
  getEventQrToken: function (eventId) {
    return request('/events/' + encodeURIComponent(eventId) + '/qr-token', {
      validate: function (data) {
        return !!data && typeof data.qrToken === 'string' && data.qrToken !== '';
      },
    });
  },

  listAttendance: function (eventId) {
    var query = eventId ? '?event_id=' + encodeURIComponent(eventId) : '';
    return request('/attendance' + query, { validate: Array.isArray });
  },

  /**
   * Fetch the sanction matrix for the reports page. The matrix is computed
   * purely from absence counts — it is not a list of manual sanction records.
   * Hydrating it on login keeps the reports page fast offline.
   * @returns {Promise<Array>}
   */
  listSanctions: function () {
    // The /reports/sanctions endpoint returns {events, students}; we store
    // the students array (which carries forSanction flags) in the cache.
    return request('/reports/sanctions', {
      validate: function (report) {
        return !!report && Array.isArray(report.students);
      },
    }).then(function (report) { return report.students; });
  },

  /**
   * Staff report rows, optionally narrowed by event and student org fields.
   * Empty filters are omitted so the endpoint treats them as "all".
   *
   * @param {{eventId?:string|number,department?:string,program?:string,yearLevel?:string}} filters
   * @returns {Promise<Array>}
   */
  attendanceReport: function (filters) {
    var f = filters || {};
    var params = [];
    if (f.eventId) params.push('eventId=' + encodeURIComponent(f.eventId));
    if (f.department) params.push('department=' + encodeURIComponent(f.department));
    if (f.program) params.push('program=' + encodeURIComponent(f.program));
    if (f.yearLevel) params.push('yearLevel=' + encodeURIComponent(f.yearLevel));
    if (f.semester) params.push('semester=' + encodeURIComponent(f.semester));
    return request('/reports/attendance' + (params.length ? '?' + params.join('&') : ''), {
      validate: Array.isArray,
    });
  },

  /**
   * Staff semester attendance matrix. Returns the events in the selected
   * scope plus one row per active student, including per-event attendance
   * flags and sanction/absence totals. Pass eventIds to scope it to several
   * events, or from/to to scope it to an inclusive date range.
   *
   * @param {{eventIds?:Array<string|number>,eventId?:string|number,from?:string,to?:string}} [filters]
   * @returns {Promise<{range:Object,events:Array,students:Array}>}
   */
  sanctionsReport: function (filters) {
    var f = filters || {};
    var params = [];
    var eventIds = Array.isArray(f.eventIds) ? f.eventIds : [];
    if (!eventIds.length && f.eventId) eventIds = [f.eventId];
    eventIds.forEach(function (eventId) {
      if (eventId !== '' && eventId !== null && eventId !== undefined) {
        params.push('eventIds[]=' + encodeURIComponent(eventId));
      }
    });
    if (f.from) params.push('from=' + encodeURIComponent(f.from));
    if (f.to) params.push('to=' + encodeURIComponent(f.to));
    if (f.semester) params.push('semester=' + encodeURIComponent(f.semester));
    if (f.department) params.push('department=' + encodeURIComponent(f.department));
    if (f.program) params.push('program=' + encodeURIComponent(f.program));
    return request('/reports/sanctions' + (params.length ? '?' + params.join('&') : ''), {
      validate: function (report) {
        return !!report && Array.isArray(report.events) && Array.isArray(report.students);
      },
    });
  },

  listAttendanceCorrections: function () {
    return request('/attendance-corrections', { validate: Array.isArray });
  },

  /**
   * Fetch one correction request's proof image on demand. The list
   * endpoint only returns hasProof, so the base64 payload stays out of
   * page loads and review responses.
   *
   * @param {number|string} requestId
   * @returns {Promise<{proofImage:string}>}
   */
  attendanceCorrectionProof: function (requestId) {
    return request('/attendance-corrections/' + encodeURIComponent(requestId) + '/proof', {
      validate: function (result) {
        return !!result && typeof result.proofImage === 'string';
      },
    });
  },

  submitAttendanceCorrection: function (eventId, checkInTime, reason, proofImage) {
    return request('/attendance-corrections', {
      method: 'POST',
      body: { eventId: eventId, checkInTime: checkInTime, reason: reason, proofImage: proofImage },
    });
  },

  reviewAttendanceCorrection: function (id, decision, notes) {
    return request('/attendance-corrections/' + encodeURIComponent(id) + '/review', {
      method: 'PATCH',
      body: { decision: decision, notes: notes || '' },
    });
  },

  listAuditLogs: function (limit) {
    var params = limit ? '?limit=' + encodeURIComponent(limit) : '';
    return request('/audit-logs' + params, { validate: Array.isArray });
  },

  listStations: function () {
    return request('/stations', { validate: Array.isArray });
  },

  createStation: function (station) {
    return request('/stations', { method: 'POST', body: station });
  },

  deleteStation: function (id) {
    return request('/stations/' + encodeURIComponent(id), { method: 'DELETE' });
  },

  heartbeatStation: function (id) {
    return request('/stations/' + encodeURIComponent(id) + '/heartbeat', { method: 'POST', anonymous: true });
  },

  qrCheckIn: function (eventId, qrToken, action) {
    return request('/attendance/qr-check-in', {
      method: 'POST',
      anonymous: true,
      body: {
        eventId: eventId,
        qrToken: qrToken,
        action: action === 'out' ? 'out' : 'in',
      },
      validate: function (row) {
        return !!row && row.studentId !== undefined && typeof row.studentName === 'string';
      },
    });
  },

  manualCheckIn: function (eventId, studentId, action) {
    return request('/attendance/manual', {
      method: 'POST',
      anonymous: true,
      body: {
        eventId: eventId,
        studentId: studentId,
        action: action === 'out' ? 'out' : 'in',
      },
    });
  },

  listReenrollmentRequests: function (studentId) {
    var query = studentId ? '?student_id=' + encodeURIComponent(studentId) : '';
    return request('/reenrollment-requests' + query, { validate: Array.isArray });
  },

  submitReenrollmentRequest: function (reason) {
    return request('/reenrollment-requests', { method: 'POST', body: { reason: reason } });
  },

  reviewReenrollmentRequest: function (id, decision) {
    return request('/reenrollment-requests/' + encodeURIComponent(id) + '/review', {
      method: 'PATCH', body: { decision: decision },
    });
  },

  /**
   * Update the signed-in student's own contact details (email, contactNumber).
   * Academic fields are read-only on the student profile page; the
   * registrar handles those.
   */
  updateOwnProfile: function (input) {
    var payload = {
      email: input && input.email != null ? String(input.email).trim() : '',
    };

    // contactNumber is optional. Send null when the field is blank so the
    // backend clears it instead of rejecting an empty string, and omit the
    // key entirely when the caller did not supply it.
    if (input && Object.prototype.hasOwnProperty.call(input, 'contactNumber')) {
      var contact = input.contactNumber == null ? '' : String(input.contactNumber).trim();
      payload.contactNumber = contact === '' ? null : contact;
    }

    return request('/users/me/profile', {
      method: 'PATCH',
      body: payload,
      validate: function (result) {
        return !!result && typeof result.email === 'string';
      },
    });
  },

  /**
   * Deactivate the signed-in student's own account.
   */
  deactivateAccount: function () {
    return request('/users/me/deactivate', {
      method: 'POST',
    });
  },
};

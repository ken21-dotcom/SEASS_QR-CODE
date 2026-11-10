// Student page-specific logic

let dashboardCalendarDate = new Date();
let dashboardSelectedDate = null;
let dashboardAttendanceByEvent = {};
let dashboardQrToken = null;
let dashboardQrEventId = null;
let currentUser = null;

// Initialize profile page on DOMContentLoaded
document.addEventListener('DOMContentLoaded', async function() {
  const user = await requireServerAuth('student');
  if (!user) return;

  currentUser = user;

  const studentName = document.getElementById('studentName');
  const todayLabel = document.getElementById('todayLabel');
  if (studentName) studentName.textContent = user.name;
  const nameParts = String(user.name || '').trim().split(/\s+/).filter(Boolean);
  const initials = nameParts.length > 1
    ? nameParts[0].charAt(0) + nameParts[nameParts.length - 1].charAt(0)
    : (nameParts[0] || 'S').slice(0, 2);
  document.querySelectorAll('.profile-avatar, .role-avatar').forEach(function (avatar) {
    avatar.textContent = initials.toUpperCase();
  });
  if (todayLabel) todayLabel.textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  if (document.getElementById('miniCalendar')) {
    loadStudentDashboard(user);

    function shiftCalendarMonth(offset) {
      dashboardCalendarDate = new Date(dashboardCalendarDate.getFullYear(), dashboardCalendarDate.getMonth() + offset, 1);
      dashboardSelectedDate = null;
      renderMiniCalendar(dashboardCalendarDate, getEvents());
      renderDashboardEvents(getEvents());
    }

    document.querySelector('[aria-label="Previous month"]').addEventListener('click', function() {
      shiftCalendarMonth(-1);
    });
    document.querySelector('[aria-label="Next month"]').addEventListener('click', function() {
      shiftCalendarMonth(1);
    });

    // Day selection is delegated so re-rendering the grid never drops it.
    document.getElementById('miniCalendar').addEventListener('click', function(event) {
      const cell = event.target.closest('[data-calendar-date]');
      if (!cell) return;
      dashboardSelectedDate = dashboardSelectedDate === cell.dataset.calendarDate
        ? null
        : cell.dataset.calendarDate;
      renderMiniCalendar(dashboardCalendarDate, getEvents());
      renderDashboardEvents(getEvents());
    });
  }

  // Announcements "View all" fills the full-list modal before it opens.
  const viewAllAnnouncements = document.getElementById('viewAllAnnouncements');
  if (viewAllAnnouncements) {
    viewAllAnnouncements.addEventListener('click', renderAllAnnouncements);
  }

  // The QR thumbnail opens the enlarged modal renderer.
  const qrEnlargeTrigger = document.getElementById('qrEnlargeTrigger');
  if (qrEnlargeTrigger) {
    qrEnlargeTrigger.addEventListener('click', openQrEnlargeModal);
  }

  // Event picker: a QR code is generated only after an event is chosen.
  const qrEventSelect = document.getElementById('qrEventSelect');
  if (qrEventSelect) {
    qrEventSelect.addEventListener('change', handleQrEventChange);
  }

  // ── Profile page wiring (Personal Info, Security, Preferences, Account) ──
  if (document.getElementById('saveProfileBtn')) {
    await initProfilePage(user);
  }

  // On attendance page: load attendance records
  if (document.getElementById('attendanceTableBody')) {
    loadStudentAttendance(user.id);
    initAttendanceCorrections();
  }

  });

/** Write static profile text, falling back to an em dash when empty. */
function setProfileText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = value === null || value === undefined ? '' : String(value).trim();
  el.textContent = text || '—';
  el.classList.toggle('profile-detail-empty', !text);
}

/** Keep the localStorage user cache in sync with a fresh server record. */
function cacheProfileUser(record) {
  if (!record || record.id == null) return;
  const users = getUsers();
  const index = users.findIndex(row => sameId(row.id, record.id));
  if (index === -1) {
    users.push(record);
  } else {
    users[index] = Object.assign({}, users[index], record);
  }
  setUsers(users);

  const session = getSession();
  if (session && sameId(session.id, record.id)) {
    setSession(Object.assign({}, session, record, {
      mustChangePassword: session.mustChangePassword === true || record.mustChangePassword === true,
    }));
  }
}

/** Reveal a green "saved" indicator for a few seconds. */
function showSavedIndicator(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('d-none');
  setTimeout(function () { el.classList.add('d-none'); }, 3000);
}

/** Render the last password change timestamp, if the API provided one. */
function setLastPasswordChange(value) {
  const el = document.getElementById('lastPasswordChangeDate');
  if (!el) return;
  if (!value) {
    el.textContent = '—';
    return;
  }
  const date = new Date(value);
  el.textContent = Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

/**
 * Initialize the profile settings page with the signed-in student's data.
 * Static academic fields are filled from getCurrentUser(); the email is fixed
 * and the contact number unlocks through the Edit Info action.
 */
async function initProfilePage(user) {
  if (!user) return;

  // The session record only carries identity fields. Prefer the hydrated
  // student row, and fetch it once when the local cache is cold.
  let profileUser = getCurrentUser() || user;
  if (isApiEnabled() && (!profileUser.studentIdNumber || !profileUser.program)) {
    try {
      const rows = await api.listUsers();
      const self = Array.isArray(rows)
        ? rows.find(row => sameId(row.id, profileUser.id))
        : null;
      if (self) {
        profileUser = Object.assign({}, profileUser, self);
        cacheProfileUser(self);
      }
    } catch (error) {
      // The identity fields from the session still render.
    }
  }
  currentUser = profileUser;

  const email = document.getElementById('profileEmail');
  const contact = document.getElementById('profileContact');
  const saveBtn = document.getElementById('saveProfileBtn');
  const saveBtnLabel = document.getElementById('saveProfileBtnLabel');
  const saveBtnIcon = document.getElementById('saveProfileBtnIcon');
  const cancelBtn = document.getElementById('cancelProfileEditBtn');

  let editingProfile = false;
  let savedEmail = profileUser.email || '';
  let savedContact = profileUser.contactNumber || profileUser.contact_number || '';

  // Toggle the editable contact field. The email is the sign-in credential
  // and always stays locked.
  function setProfileEditing(editing) {
    editingProfile = editing;
    if (email) email.readOnly = true;
    if (contact) contact.readOnly = !editing;
    if (cancelBtn) cancelBtn.classList.toggle('d-none', !editing);
    if (saveBtnLabel) saveBtnLabel.textContent = editing ? 'Save Changes' : 'Edit Info';
    if (saveBtnIcon) {
      saveBtnIcon.className = editing ? 'bi bi-check2-circle me-2' : 'bi bi-pencil-square me-2';
    }
  }

  setProfileText('profileFullNameValue', profileUser.name);
  setProfileText('profileStudentIdValue', profileUser.studentIdNumber);
  setProfileText('profileProgramValue', profileUser.program
    ? (typeof programLabel === 'function' ? programLabel(profileUser.program) : profileUser.program)
    : '');
  setProfileText('profileYearLevelValue', profileUser.yearLevel
    ? (typeof getStudentYearLabel === 'function' ? getStudentYearLabel(profileUser.yearLevel) : profileUser.yearLevel)
    : '');
  setProfileText('profileBlockValue', profileUser.block);

  if (email) email.value = savedEmail;
  if (contact) contact.value = savedContact;
  setLastPasswordChange(profileUser.lastPasswordChange);
  setProfileEditing(false);

  // Cancel discards the draft and returns to the saved values.
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function () {
      if (email) email.value = savedEmail;
      if (contact) contact.value = savedContact;
      setProfileEditing(false);
      if (saveBtn) saveBtn.focus();
    });
  }

  // Edit Info unlocks the fields; the same button then saves the draft.
  if (saveBtn) {
    saveBtn.addEventListener('click', async function () {
      if (!currentUser) return;

      if (!editingProfile) {
        setProfileEditing(true);
        if (contact) contact.focus();
        return;
      }

      // Snapshot exactly what the student typed. If the request fails we
      // keep these edits on screen instead of restoring stale data.
      const submittedEmail = email ? email.value : '';
      const submittedContact = contact ? contact.value : '';

      saveBtn.disabled = true;
      if (cancelBtn) cancelBtn.disabled = true;
      try {
        const updated = await api.updateOwnProfile({
          email: submittedEmail.trim(),
          contactNumber: submittedContact,
        });
        if (updated && updated.id) {
          currentUser = Object.assign({}, currentUser, updated);
          cacheProfileUser(currentUser);
        }
        if (updated) {
          savedEmail = typeof updated.email === 'string' ? updated.email : submittedEmail.trim();
          savedContact = updated.contactNumber || '';
          if (email) email.value = savedEmail;
          if (contact) contact.value = savedContact;
        }
        setProfileEditing(false);
        showToast('success', 'Personal information updated.');
        showSavedIndicator('profileSavedMsg');
      } catch (error) {
        if (email) email.value = submittedEmail;
        if (contact) contact.value = submittedContact;
        if (error.code === 'phone_taken' && contact) {
          contact.focus();
        }
        showToast('error', error.message || 'Could not update personal information.');
      } finally {
        saveBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
      }
    });
  }

  // Password update.
  const updatePasswordBtn = document.getElementById('updatePasswordBtn');
  if (updatePasswordBtn) {
    updatePasswordBtn.addEventListener('click', async function () {
      const currentPasswordEl = document.getElementById('currentPassword');
      const newPasswordEl = document.getElementById('newPassword');
      const confirmPasswordEl = document.getElementById('confirmPassword');
      const currentPassword = currentPasswordEl ? currentPasswordEl.value : '';
      const newPassword = newPasswordEl ? newPasswordEl.value : '';
      const confirmPassword = confirmPasswordEl ? confirmPasswordEl.value : '';

      if (!currentPassword || !newPassword || !confirmPassword) {
        showToast('error', 'Please fill all password fields.');
        return;
      }
      if (newPassword !== confirmPassword) {
        showToast('error', 'New passwords do not match.');
        return;
      }
      if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
        showToast('error', 'New password must be at least 8 characters and include a letter and a number.');
        return;
      }

      updatePasswordBtn.disabled = true;
      try {
        await api.changePassword(currentPassword, newPassword);
        showToast('success', 'Password updated successfully.');
        showSavedIndicator('passwordSavedMsg');
        if (currentPasswordEl) currentPasswordEl.value = '';
        if (newPasswordEl) newPasswordEl.value = '';
        if (confirmPasswordEl) confirmPasswordEl.value = '';
        const now = new Date().toISOString();
        currentUser = Object.assign({}, currentUser, { lastPasswordChange: now });
        cacheProfileUser(currentUser);
        setLastPasswordChange(now);
      } catch (error) {
        showToast('error', error.message || 'Password update failed.');
      } finally {
        updatePasswordBtn.disabled = false;
      }
    });
  }

  // Toggle password visibility.
  document.querySelectorAll('.toggle-password').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const targetId = btn.getAttribute('data-target');
      const target = document.getElementById(targetId);
      if (!target) return;
      const type = target.getAttribute('type') === 'password' ? 'text' : 'password';
      target.setAttribute('type', type);
      btn.innerHTML = type === 'password' ? '<i class="bi bi-eye"></i>' : '<i class="bi bi-eye-slash"></i>';
      btn.setAttribute('aria-label', type === 'password' ? 'Show password' : 'Hide password');
    });
  });

  // Deactivate account flow.
  const deactivateBtn = document.getElementById('confirmDeactivateBtn');
  const deactivateConfirm = document.getElementById('deactivateConfirm');
  const deactivateError = document.getElementById('deactivateError');
  if (deactivateBtn && deactivateConfirm && deactivateError) {
    deactivateConfirm.addEventListener('input', function () {
      const val = deactivateConfirm.value;
      deactivateBtn.disabled = val.trim().toUpperCase() !== 'DEACTIVATE';
      deactivateError.textContent = '';
    });
    deactivateBtn.addEventListener('click', async function () {
      const val = deactivateConfirm.value.trim().toUpperCase();
      if (val !== 'DEACTIVATE') {
        deactivateError.textContent = 'Please type DEACTIVATE to confirm.';
        return;
      }
      deactivateBtn.disabled = true;
      try {
        await api.deactivateAccount();
        showToast('success', 'Account deactivated. You have been signed out.');
        setTimeout(() => {
          logout();
          window.location.href = 'login.html';
        }, 2000);
      } catch (error) {
        deactivateError.textContent = error.message || 'Could not deactivate account.';
        deactivateBtn.disabled = false;
      }
    });
  }
}

/**
 * Attendance rate for one student: present/late check-ins over events that
 * have already ended. Future and in-progress events are not absences, and
 * the denominator never drops below the number of check-ins.
 */
function calculateAttendanceRate(events, attendance, now = new Date()) {
  const presentCount = attendance.filter(record => record.status === 'present' || record.status === 'late').length;
  const completedEvents = events.filter(event => hasEventEnded(event, now));
  const totalEvents = Math.max(completedEvents.length, presentCount);
  return totalEvents ? Math.round((presentCount / totalEvents) * 100) : 0;
}

function loadStudentDashboard(user) {
  const firstName = user.name.split(' ')[0];
  document.getElementById('studentName').textContent = user.name;
  document.getElementById('welcomeName').textContent = firstName;
  document.getElementById('todayLabel').textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  const events = getEvents();
  const attendance = getAttendance().filter(record => sameId(record.studentId, user.id));
  dashboardAttendanceByEvent = {};
  attendance.forEach(record => {
    // Loose null check: the id may arrive as a number or a numeric string.
    if (record && record.eventId != null) {
      dashboardAttendanceByEvent[String(record.eventId)] = record;
    }
  });
  const presentCount = attendance.filter(record => record.status === 'present' || record.status === 'late').length;
  // Future events are not absences, so only events that have already ended
  // count in the denominator; otherwise the rate falls as more of the
  // semester is scheduled.
  const attendanceRate = calculateAttendanceRate(events, attendance);
  const absentRate = Math.max(0, 100 - attendanceRate);

  document.getElementById('attendanceRate').textContent = `${attendanceRate}%`;
  document.getElementById('attendanceProgress').style.width = `${attendanceRate}%`;
  document.getElementById('presentCount').textContent = presentCount;
  document.getElementById('sanctionCount').textContent = 0;

  // ── Render Chart ──
  const donut = document.getElementById('attendanceDonut');
  if (donut) {
    const percentage = attendanceRate;
    donut.style.background = `conic-gradient(var(--brand-600) ${percentage}%, var(--color-border-default) ${percentage}% 100%)`;
  }
  const donutPercent = document.getElementById('donutPercent');
  if (donutPercent) donutPercent.textContent = `${attendanceRate}%`;
  const presentLegend = document.getElementById('presentLegend');
  if (presentLegend) presentLegend.textContent = `${attendanceRate}%`;
  const absentLegend = document.getElementById('absentLegend');
  if (absentLegend) absentLegend.textContent = `${absentRate}%`;

  // ── Render Recent Attendance Activity ──
  const activityList = document.getElementById('recentActivityList');
  if (activityList) {
    const recent = attendance.sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5);
    if (!recent.length) {
      activityList.innerHTML = '<div class="text-muted p-3">No recent attendance records.</div>';
    } else {
      activityList.innerHTML = recent.map(record => {
        const event = events.find(e => sameId(e.id, record.eventId)) || { name: 'Unknown Event' };
        return `
          <div class="activity-item">
            <div class="activity-icon ${record.status}"><i class="bi bi-clock-history"></i></div>
            <div class="activity-text">
              <strong>${escapeHtml(event.name)}</strong>
              <span>${escapeHtml(record.status.charAt(0).toUpperCase() + record.status.slice(1))} at ${escapeHtml(record.time || '')}</span>
            </div>
          </div>`;
      }).join('');
    }
  }

  renderAnnouncements();

  // The panel is rendered from the hydrated cache first, then refreshed from
  // the database so a staff edit or deletion made after this session logged
  // in cannot leave a stale announcement on the dashboard.
  if (typeof isApiEnabled === 'function' && isApiEnabled()) {
    api.listAnnouncements()
      .then(function (rows) {
        if (!Array.isArray(rows)) return;
        setAnnouncements(rows);
        renderAnnouncements();
        updateNotificationBadge();
      })
      .catch(function () {
        // Keep the cached list when the server is unavailable.
      });
  }

  renderMiniCalendar(dashboardCalendarDate, events);
  renderDashboardEvents(events);
  loadWeather();

  // Phase 2: the QR card becomes event-scoped. Populate the picker and
  // leave the card on its "select an event" empty state until the student
  // chooses one; only then is a signed token requested from the server.
  renderQrEventOptions(events);
}

/**
 * Open the enlarge modal and draw a 320px copy of the student's QR code into
 * its container. The dashboard thumbnail keeps its compact size.
 */
function openQrEnlargeModal() {
  const modalElement = document.getElementById('qrCodeEnlargeModal');
  if (!modalElement) return;

  // The trigger is hidden until a token exists, but guard the modal anyway
  // so a keyboard/programmatic open can never show an empty QR canvas.
  if (!dashboardQrToken) {
    const select = document.getElementById('qrEventSelect');
    if (select) select.focus();
    return;
  }

  if (typeof window.renderStudentQr === 'function') {
    window.renderStudentQr('enlargedQrContainer', dashboardQrToken, 320);
  }

  if (window.bootstrap && typeof window.bootstrap.Modal === 'function') {
    window.bootstrap.Modal.getOrCreateInstance(modalElement).show();
  }
}

/* ── Event-specific check-in QR ───────────────────────────────── */

/**
 * End instant for an event, including events that finish after midnight.
 * Returns null when the date cannot be parsed.
 */
function eventEndMoment(event) {
  if (!event || !event.date) return null;

  const date = String(event.date).slice(0, 10);
  const startTime = String(event.startTime || event.time || '00:00').slice(0, 5);
  const endTime = String(event.endTime || '23:59').slice(0, 5);
  const startsAt = new Date(date + 'T' + startTime);
  let endsAt = new Date(date + 'T' + endTime);

  if (Number.isNaN(endsAt.getTime())) {
    const dayEnd = new Date(date + 'T23:59:59');
    return Number.isNaN(dayEnd.getTime()) ? null : dayEnd;
  }

  // An event that ends at or before it starts runs into the next day.
  if (!Number.isNaN(startsAt.getTime()) && endsAt <= startsAt) {
    endsAt = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
  }
  return endsAt;
}

/** True when the event's end instant has passed. */
function hasEventEnded(event, now = new Date()) {
  const endsAt = eventEndMoment(event);
  return endsAt !== null && endsAt <= now;
}

/** Start instant for an event. */
function eventStartMoment(event) {
  if (!event || !event.date) return null;
  const date = String(event.date).slice(0, 10);
  const startTime = String(event.startTime || event.time || '00:00').slice(0, 5);
  const startsAt = new Date(date + 'T' + startTime);
  return Number.isNaN(startsAt.getTime()) ? null : startsAt;
}

/** Events whose scheduled window contains the supplied instant. */
function liveQrEvents(events, now = new Date()) {
  return (events || [])
    .filter(event => event && event.id != null && String(event.status || 'scheduled') === 'scheduled')
    .filter(event => {
      const startsAt = eventStartMoment(event);
      const endsAt = eventEndMoment(event);
      return startsAt !== null && endsAt !== null && startsAt <= now && now <= endsAt;
    })
    .sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));
}

function clearQrDisplay() {
  dashboardQrToken = null;
  dashboardQrEventId = null;
  const button = document.getElementById('qrEnlargeTrigger');
  const canvas = document.getElementById('studentQrCanvas');
  if (button) button.hidden = true;
  if (canvas) canvas.innerHTML = '';
}

function setQrCardMessage(message, showCanvas = false) {
  const hint = document.getElementById('qrCardHint');
  if (hint) hint.textContent = message;

  const button = document.getElementById('qrEnlargeTrigger');
  const canvas = document.getElementById('studentQrCanvas');
  if (button) button.hidden = !showCanvas;
  if (canvas) canvas.innerHTML = '';
  return { button, canvas };
}

function resetQrCard() {
  clearQrDisplay();
  setQrCardMessage('No active events right now. Your check-in QR will appear here when an event starts.');
}

/** Populate and automatically select the currently live event(s). */
function renderQrEventOptions(events) {
  const select = document.getElementById('qrEventSelect');
  const picker = select ? select.closest('.qr-event-picker') : null;
  const liveEvents = liveQrEvents(events);
  console.log('[QR] renderQrEventOptions: liveEvents=', liveEvents.length, 'total events=', (events || []).length);

  clearQrDisplay();
  if (select) select.innerHTML = '';

  if (liveEvents.length === 0) {
    if (picker) picker.hidden = true;
    // The cache can be stale in two ways: empty (a student on a new device
    // before hydrateFromApi() finished) or populated but missing events that
    // were created after it was written. Both need a one-shot server refresh;
    // only refreshing when the cache is empty is what let a freshly created
    // event stay invisible until the next logout/login.
    if (!events || events.length === 0) {
      console.log('[QR] No events in local cache — attempting API refresh.');
    } else {
      console.log('[QR] No live events among', events.length, 'cached events. Event statuses:', events.map(e => String(e.status || 'missing')).join(', '), '— cache may be stale, attempting API refresh.');
    }
    refreshEventsForQr();
    return;
  }

  console.log('[QR] Found', liveEvents.length, 'live event(s); auto-selecting.');
  if (liveEvents.length === 1) {
    if (picker) picker.hidden = true;
    const event = liveEvents[0];
    if (select) select.value = String(event.id);
    handleQrEventChange(event);
    return;
  }

  if (picker) picker.hidden = false;
  if (!select) return;

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a live event…';
  select.appendChild(placeholder);

  liveEvents.forEach(event => {
    const option = document.createElement('option');
    option.value = String(event.id);
    option.textContent = String(event.name || 'Untitled event') + ' — ' + formatDate(event.date);
    select.appendChild(option);
  });

  select.disabled = false;
  setQrCardMessage('Choose the live event you are attending.');
}

/** Ask the server for an event's signed token and render it. */
async function handleQrEventChange(eventOverride = null) {
  const select = document.getElementById('qrEventSelect');
  const eventId = eventOverride
    ? String(eventOverride.id)
    : String(select ? select.value || '' : '');
  const event = eventOverride || (getEvents() || []).find(row => sameId(row.id, eventId));
  const button = document.getElementById('qrEnlargeTrigger');

  console.log('[QR] handleQrEventChange: eventId=', eventId, 'event=', event ? event.name : 'null');
  if (!eventId || eventId === 'undefined' || eventId === 'null') {
    console.error('[QR] handleQrEventChange: invalid eventId —', eventId);
    clearQrDisplay();
    setQrCardMessage('No event selected. Please choose a live event.');
    return;
  }

  clearQrDisplay();
  setQrCardMessage('Generating your check-in QR code…');
  if (select) select.disabled = true;

  try {
    console.log('[QR] Fetching token from GET /events/' + eventId + '/qr-token');
    const payload = await api.getEventQrToken(eventId);
    const token = String(payload.qrToken || payload.qr_token || '');
    if (!token) throw new Error('The server did not return a QR code.');

    dashboardQrToken = token;
    dashboardQrEventId = eventId;
    console.log('[QR] Token received — rendering QR for event', eventId);
    if (typeof window.renderStudentQr === 'function') {
      window.renderStudentQr('studentQrCanvas', token, 160);
    }
    if (button) button.hidden = false;

    const hint = document.getElementById('qrCardHint');
    if (hint) hint.textContent = 'You are checking in to: ' + (event ? event.name : 'selected event') + '.';
  } catch (error) {
    console.error('[QR] Token fetch failed for event', eventId, ':', error && error.message ? error.message : error, '| code:', error && error.code, '| status:', error && error.status);
    clearQrDisplay();
    // Surface a distinct message when the server itself rejected the request
    // so the student (or support staff reading the screen) can tell a network
    // failure from a "no live event" state.
    const serverMsg = error && error.status ? error.message : null;
    setQrCardMessage(serverMsg || (error && error.message) || 'Could not generate a QR code for this event. Please try again.');
  } finally {
    if (select) select.disabled = false;
  }
}

/* ── Weather (Open-Meteo) ─────────────────────────────────────── */

var weatherRefreshTimer = null;

/**
 * WMO Weather interpretation codes → description + Bootstrap icon.
 * Reference: https://open-meteo.com/en/docs#weathervariables
 */
var WMO_CODES = {
  0:  { desc: 'Clear sky',          icon: 'bi-sun' },
  1:  { desc: 'Mainly clear',       icon: 'bi-sun' },
  2:  { desc: 'Partly cloudy',      icon: 'bi-cloud-sun' },
  3:  { desc: 'Overcast',           icon: 'bi-cloud' },
  45: { desc: 'Fog',                icon: 'bi-cloud-fog' },
  48: { desc: 'Depositing rime fog',icon: 'bi-cloud-fog' },
  51: { desc: 'Light drizzle',      icon: 'bi-cloud-drizzle' },
  53: { desc: 'Moderate drizzle',   icon: 'bi-cloud-drizzle' },
  55: { desc: 'Dense drizzle',      icon: 'bi-cloud-drizzle' },
  56: { desc: 'Freezing drizzle',   icon: 'bi-cloud-drizzle' },
  57: { desc: 'Dense freezing drizzle', icon: 'bi-cloud-drizzle' },
  61: { desc: 'Slight rain',        icon: 'bi-cloud-rain' },
  63: { desc: 'Moderate rain',      icon: 'bi-cloud-rain' },
  65: { desc: 'Heavy rain',         icon: 'bi-cloud-rain-heavy' },
  66: { desc: 'Freezing rain',      icon: 'bi-cloud-rain' },
  67: { desc: 'Heavy freezing rain',icon: 'bi-cloud-rain-heavy' },
  71: { desc: 'Slight snow',        icon: 'bi-snow' },
  73: { desc: 'Moderate snow',      icon: 'bi-snow' },
  75: { desc: 'Heavy snow',         icon: 'bi-snow' },
  77: { desc: 'Snow grains',        icon: 'bi-snow' },
  80: { desc: 'Rain showers',       icon: 'bi-cloud-rain' },
  81: { desc: 'Moderate rain showers', icon: 'bi-cloud-rain-heavy' },
  82: { desc: 'Violent rain showers',  icon: 'bi-cloud-rain-heavy' },
  85: { desc: 'Snow showers',       icon: 'bi-snow' },
  86: { desc: 'Heavy snow showers', icon: 'bi-snow' },
  95: { desc: 'Thunderstorm',       icon: 'bi-cloud-lightning' },
  96: { desc: 'Thunderstorm with hail', icon: 'bi-cloud-lightning' },
  99: { desc: 'Thunderstorm with heavy hail', icon: 'bi-cloud-lightning' },
};

function wmoLookup(code) {
  return WMO_CODES[code] || { desc: 'Unknown', icon: 'bi-question-circle' };
}

/**
 * Pick the hourly value whose timestamp (Asia/Manila, ISO) matches the API's
 * current forecast time, so the correct hour is used regardless of the
 * viewer's device clock/timezone. Falls back to the nearest future hour.
 */
function pickHourlyValue(times, values, currentTime) {
  if (!times || !values || !times.length) return null;
  var target = (currentTime || '').slice(0, 13);
  if (!target) return values[0];
  for (var i = 0; i < times.length; i++) {
    if (times[i].slice(0, 13) >= target) return values[i];
  }
  return values[values.length - 1];
}

function loadWeather() {
  // Clear any existing auto-refresh timer to avoid stacking
  if (weatherRefreshTimer) { clearInterval(weatherRefreshTimer); weatherRefreshTimer = null; }

  // JHCSC Balangasan, Pagadian City
  var LAT  = 7.8265;
  var LON  = 123.4198;
  var API  = 'https://api.open-meteo.com/v1/forecast'
           + '?latitude=' + LAT
           + '&longitude=' + LON
           + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code'
           + '&hourly=precipitation_probability'
           + '&timezone=Asia/Manila'
           + '&forecast_days=1';

  var tempEl      = document.getElementById('weatherTemp');
  var condEl      = document.getElementById('weatherCondition');
  var feelsEl     = document.getElementById('weatherFeelsLike');
  var humEl       = document.getElementById('weatherHumidity');
  var rainEl      = document.getElementById('weatherRain');
  var iconWrap    = document.getElementById('weatherIcon');
  var updatedEl   = document.getElementById('weatherUpdated');

  function showUnavailable() {
    if (tempEl) tempEl.textContent  = '--°';
    if (condEl) condEl.textContent  = 'Weather data unavailable';
    if (feelsEl) feelsEl.textContent = '';
    if (humEl) humEl.textContent   = '--%';
    if (rainEl) rainEl.textContent  = '--%';
    if (iconWrap) iconWrap.innerHTML  = '<i class="bi bi-cloud-slash"></i>';
    if (updatedEl) updatedEl.textContent = '';
  }

  var attempts = 0;
  var maxAttempts = 3;

  function callApi() {
    attempts++;

    // Manual timeout so older browsers without AbortSignal.timeout still work
    var controller = new AbortController();
    var timeoutId  = setTimeout(function () { controller.abort(); }, 10000);

    fetch(API, { signal: controller.signal })
      .then(function (res) {
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var cur     = data.current;
        var rainProb = data.hourly && data.hourly.precipitation_probability
          ? pickHourlyValue(data.hourly.time, data.hourly.precipitation_probability, cur.time)
          : null;

        var info = wmoLookup(cur.weather_code);

        if (tempEl) tempEl.textContent    = Math.round(cur.temperature_2m) + '°';
        if (condEl) condEl.textContent    = info.desc;
        if (feelsEl) feelsEl.textContent   = 'Feels like ' + Math.round(cur.apparent_temperature) + '°';
        if (humEl) humEl.textContent     = cur.relative_humidity_2m + '%';
        if (rainEl) rainEl.textContent    = rainProb !== null ? rainProb + '%' : '—';
        if (iconWrap) iconWrap.innerHTML    = '<i class="bi ' + info.icon + '"></i>';

        var now = new Date();
        if (updatedEl) updatedEl.textContent = 'Updated '
          + now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

        // Auto-refresh every 15 minutes
        weatherRefreshTimer = setInterval(loadWeather, 15 * 60 * 1000);
      })
      .catch(function () {
        clearTimeout(timeoutId);
        if (attempts < maxAttempts) {
          setTimeout(callApi, 1000 * attempts);
          return;
        }
        showUnavailable();
      });
  }

  callApi();
}

function announcementItemHTML(announcement) {
  return `
    <div class="announcement-item">
      <span class="announcement-icon ${announcement.type === 'event' ? 'event-icon' : ''}"><i class="bi bi-${announcement.type === 'event' ? 'calendar-event' : 'megaphone'}"></i></span>
      <div><strong>${escapeHtml(announcement.title)}</strong><small>${escapeHtml(announcement.detail)}</small></div>
    </div>`;
}

function renderAnnouncements() {
  const container = document.getElementById('announcementList');
  if (!container) return;
  const announcements = getAnnouncements();
  container.innerHTML = announcements.slice(0, 3).map(announcementItemHTML).join('');
}

/** "YYYY-MM-DD" → "Nov 4, 2026" without shifting the day across time zones. */
function formatAnnouncementDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** One full-list row: same icon/title layout as the panel, plus the date. */
function announcementModalItemHTML(announcement) {
  const isEvent = announcement.type === 'event';
  const date = formatAnnouncementDate(announcement.date);
  return `
    <div class="announcement-item">
      <span class="announcement-icon ${isEvent ? 'event-icon' : ''}"><i class="bi bi-${isEvent ? 'calendar-event' : 'megaphone'}"></i></span>
      <div class="announcement-item-copy">
        <strong>${escapeHtml(announcement.title)}</strong>
        <small>${escapeHtml(announcement.detail)}</small>
        ${date ? `<small class="announcement-date"><i class="bi bi-calendar3" aria-hidden="true"></i>${escapeHtml(date)}</small>` : ''}
      </div>
    </div>`;
}

/** Populate the "View all" modal with every announcement, not just the first 3. */
function renderAllAnnouncements() {
  const container = document.getElementById('allAnnouncementList');
  if (!container) return;
  const announcements = getAnnouncements();
  if (!announcements.length) {
    container.innerHTML = `
      <div class="announcement-empty">
        <i class="bi bi-megaphone" aria-hidden="true"></i>
        <strong>No announcements yet</strong>
        <span>New campus announcements will appear here.</span>
      </div>`;
    return;
  }
  container.innerHTML = announcements.map(announcementModalItemHTML).join('');
}

/* ── Notifications panel ────────────────────────────────────── */

const READ_KEY = 'attendly_read_announcements';

function getReadAnnouncements() {
  try { return JSON.parse(localStorage.getItem(READ_KEY)) || []; } catch (e) { return []; }
}

function unreadAnnouncementCount() {
  const announcements = getAnnouncements();
  const read = getReadAnnouncements();
  return announcements.filter(a => !read.includes(a.id)).length;
}

function renderNotificationList() {
  const list = document.getElementById('notificationList');
  const announcements = getAnnouncements();
  if (!announcements.length) {
    list.innerHTML = '<p class="notification-empty">No announcements yet.</p>';
    return;
  }
  list.innerHTML = announcements.map(announcementItemHTML).join('');
}

function openNotifications() {
  const panel = document.getElementById('notificationPanel');
  const backdrop = document.getElementById('notificationBackdrop');
  if (!panel) return;
  renderNotificationList();
  panel.hidden = false;
  if (backdrop) backdrop.hidden = false;
  document.body.classList.add('notification-open');
  // Mark current announcements as read and refresh the badge
  const read = getReadAnnouncements();
  const ids = getAnnouncements().map(a => a.id);
  localStorage.setItem(READ_KEY, JSON.stringify(Array.from(new Set([...read, ...ids]))));
  updateNotificationBadge();
}

function closeNotifications() {
  const panel = document.getElementById('notificationPanel');
  const backdrop = document.getElementById('notificationBackdrop');
  if (panel) panel.hidden = true;
  if (backdrop) backdrop.hidden = true;
  document.body.classList.remove('notification-open');
}

function updateNotificationBadge() {
  const badge = document.getElementById('notificationBadge');
  if (!badge) return;
  const count = unreadAnnouncementCount();
  badge.textContent = count > 9 ? '9+' : count;
  badge.classList.toggle('hidden', count === 0);
}

/** "HH:MM" (or "HH:MM:SS") → "8:00 AM". */
function formatEventClock(value) {
  const text = String(value || '').slice(0, 5);
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return '';
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return '';
  const suffix = hours >= 12 ? 'PM' : 'AM';
  return (hours % 12 || 12) + ':' + String(minutes).padStart(2, '0') + ' ' + suffix;
}

/** Human time range for an event, tolerating a missing start or end. */
function eventTimeRange(event) {
  const start = formatEventClock(event && (event.startTime || event.time));
  const end = formatEventClock(event && event.endTime);
  if (start && end) return start + ' – ' + end;
  return start || end || 'Time to be announced';
}

/** Sort key: event date then start time. */
function eventSortKey(event) {
  return String(event.date || '').slice(0, 10) + 'T' +
    String(event.startTime || event.time || '23:59').slice(0, 5);
}

/**
 * Attendance standing for one event: checked in, absent, or still upcoming.
 * Uses the student's hydrated attendance rows (dashboardAttendanceByEvent).
 */
function eventAttendanceState(event) {
  const record = dashboardAttendanceByEvent[String(event.id)];
  if (record) {
    const status = String(record.status || 'present').toLowerCase();
    if (status === 'late') return { className: 'late', label: 'Checked in late' };
    if (status === 'absent') return { className: 'absent', label: 'Absent' };
    if (status === 'excused') return { className: 'excused', label: 'Excused' };
    return { className: 'present', label: 'Checked in' };
  }
  if (String(event.status || '') === 'cancelled') return { className: 'cancelled', label: 'Cancelled' };
  if (hasEventEnded(event)) return { className: 'absent', label: 'Absent' };
  return { className: 'upcoming', label: 'Upcoming' };
}

/** Mandatory/category badges shown on an event row. */
function eventBadgesHtml(event) {
  if (String(event.status || '') === 'cancelled') {
    return '<span class="event-badge is-cancelled">Cancelled</span>';
  }
  const badges = [
    event.mandatory
      ? '<span class="event-badge is-mandatory"><i class="bi bi-asterisk" aria-hidden="true"></i>Mandatory</span>'
      : '<span class="event-badge is-optional">Optional</span>'
  ];
  if (event.category === 'major') badges.push('<span class="event-badge is-major">Major event</span>');
  else if (event.category === 'minor') badges.push('<span class="event-badge is-minor">Minor event</span>');
  return badges.join('');
}

/** One row in the upcoming/past lists and in the selected-day detail. */
function eventItemHtml(event) {
  const attendance = eventAttendanceState(event);
  const isCancelled = String(event.status || '') === 'cancelled';
  const isPast = !isCancelled && hasEventEnded(event);
  const date = String(event.date || '').slice(0, 10);
  const dateObj = new Date(date + 'T00:00:00');
  const validDate = !Number.isNaN(dateObj.getTime());
  const month = validDate ? dateObj.toLocaleDateString(undefined, { month: 'short' }) : '—';
  const day = validDate ? String(dateObj.getDate()) : '—';
  const dow = validDate ? dateObj.toLocaleDateString(undefined, { weekday: 'short' }) : '';
  const stateClass = isCancelled ? 'is-cancelled' : isPast ? 'is-past' : 'is-upcoming';

  return '<li class="upcoming-event-item dashboard-event-item ' + stateClass + '">' +
    '<div class="event-date-badge" aria-hidden="true">' +
      '<span class="ev-month">' + escapeHtml(month) + '</span>' +
      '<span class="ev-day">' + escapeHtml(day) + '</span>' +
      '<span class="ev-dow">' + escapeHtml(dow) + '</span>' +
    '</div>' +
    '<div class="event-info">' +
      '<strong>' + escapeHtml(event.name || 'Untitled event') + '</strong>' +
      '<small class="dashboard-event-meta"><i class="bi bi-clock" aria-hidden="true"></i> ' + escapeHtml(eventTimeRange(event)) +
        '<span class="dashboard-event-sep" aria-hidden="true">·</span>' +
        '<i class="bi bi-geo-alt" aria-hidden="true"></i> ' + escapeHtml(event.location || 'Venue to be announced') + '</small>' +
      '<div class="dashboard-event-badges">' + eventBadgesHtml(event) + '</div>' +
    '</div>' +
    '<span class="status-badge ' + safeToken(attendance.className, ['present', 'late', 'absent', 'excused', 'upcoming', 'cancelled']) + '">' + escapeHtml(attendance.label) + '</span>' +
  '</li>';
}

function eventEmptyHtml(message, icon) {
  return '<li class="dashboard-event-empty"><i class="bi ' + icon + '" aria-hidden="true"></i><span>' + escapeHtml(message) + '</span></li>';
}

/** Details for the day selected on the calendar. */
function renderSelectedDayDetails(events) {
  const box = document.getElementById('selectedDayDetails');
  if (!box) return;
  if (!dashboardSelectedDate) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }

  const dayEvents = (events || [])
    .filter(event => String(event.date || '').slice(0, 10) === dashboardSelectedDate)
    .sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));
  const dateObj = new Date(dashboardSelectedDate + 'T00:00:00');
  const label = Number.isNaN(dateObj.getTime())
    ? dashboardSelectedDate
    : dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  box.hidden = false;
  box.innerHTML = '<div class="selected-day-head">' +
      '<div><p class="section-kicker">Selected day</p><h4>' + escapeHtml(label) + '</h4></div>' +
      '<button type="button" class="btn btn-sm btn-outline-secondary" id="clearSelectedDay">Clear</button>' +
    '</div>' +
    (dayEvents.length
      ? '<ul class="dashboard-event-list">' + dayEvents.map(eventItemHtml).join('') + '</ul>'
      : '<p class="dashboard-event-empty"><i class="bi bi-calendar-x" aria-hidden="true"></i><span>No events on this day.</span></p>');

  const clear = box.querySelector('#clearSelectedDay');
  if (clear) {
    clear.addEventListener('click', function () {
      dashboardSelectedDate = null;
      renderMiniCalendar(dashboardCalendarDate, getEvents());
      renderDashboardEvents(getEvents());
    });
  }
}

/**
 * One-shot retry for the QR section when the localStorage event cache is
 * empty on page load. The dashboard's main list reads from the same cache,
 * but a student who lands on the page before hydrateFromApi() has completed
 * (or on a device with a cold cache) would otherwise see "No active events"
 * even though the server has scheduled events for them.
 */
let qrRefreshInFlight = false;

async function refreshEventsForQr() {
  if (typeof api === 'undefined' || typeof api.listEvents !== 'function') return;
  if (typeof isApiEnabled === 'function' && !isApiEnabled()) return;
  // One-shot: renderQrEventOptions calls this when it finds no live events,
  // and refreshEventsForQr() calls renderQrEventOptions() again below, so
  // without this guard a stale cache would ping-pong until the request ends.
  if (qrRefreshInFlight) return;
  qrRefreshInFlight = true;
  try {
    const events = await api.listEvents();
    if (Array.isArray(events) && events.length) {
      setEvents(events);
      const liveNow = liveQrEvents(events);
      console.log('[QR] API refresh fetched', events.length, 'events,', liveNow.length, 'live now.');
      if (liveNow.length === 1) {
        const select = document.getElementById('qrEventSelect');
        if (select) select.value = String(liveNow[0].id);
        handleQrEventChange(liveNow[0]);
      } else if (liveNow.length > 1) {
        renderQrEventOptions(events);
      }
    } else {
      console.log('[QR] API returned no events for this student.');
    }
  } catch (error) {
    console.error('[QR] API refresh failed:', error && error.message ? error.message : error);
  } finally {
    // Release the guard so a later render (e.g. an event starting after this
    // attempt) can still trigger a refresh.
    qrRefreshInFlight = false;
  }
}

/** Populate the upcoming and recent-past lists beside the calendar. */
function renderDashboardEvents(events) {
  const upcomingList = document.getElementById('upcomingEventsList');
  const pastList = document.getElementById('pastEventsList');
  if (!upcomingList && !pastList) return;

  const now = new Date();
  const all = (events || []).filter(event => event && event.date);
  const active = all.filter(event => String(event.status || '') !== 'cancelled');
  const sorted = active.slice().sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));
  const upcoming = sorted.filter(event => !hasEventEnded(event, now));
  const past = sorted.filter(event => hasEventEnded(event, now)).reverse().slice(0, 5);

  if (upcomingList) {
    upcomingList.innerHTML = upcoming.length
      ? upcoming.map(eventItemHtml).join('')
      : eventEmptyHtml('No upcoming events yet.', 'bi-calendar-plus');
  }
  if (pastList) {
    pastList.innerHTML = past.length
      ? past.map(eventItemHtml).join('')
      : eventEmptyHtml('No past events yet.', 'bi-clock-history');
  }

  const count = document.getElementById('eventsPanelCount');
  if (count) {
    count.textContent = upcoming.length + ' upcoming · ' + past.length + ' recent';
  }
  renderSelectedDayDetails(all);
}

function renderMiniCalendar(monthDate, events) {
  const calendar = document.getElementById('miniCalendar');
  if (!calendar) return;
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const visibleEvents = (events || []).filter(event => event && event.date);
  const cells = [];

  for (let blankDay = 0; blankDay < firstDay; blankDay += 1) cells.push('<span class="calendar-cell empty"></span>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${monthPrefix}-${String(day).padStart(2, '0')}`;
    const isToday = dateKey === todayKey;
    const dayEvents = visibleEvents.filter(event => String(event.date).slice(0, 10) === dateKey);
    const hasEvent = dayEvents.length > 0;
    const activeDayEvents = dayEvents.filter(event => String(event.status || '') !== 'cancelled');
    const hasActive = activeDayEvents.length > 0;
    const hasUpcoming = hasActive && activeDayEvents.some(event => !hasEventEnded(event, now));
    const allEnded = hasActive && !hasUpcoming;
    const cancelledOnly = hasEvent && !hasActive;
    const stateClass = !hasEvent
      ? ''
      : cancelledOnly ? 'is-cancelled-event' : hasUpcoming ? 'is-upcoming-event' : 'is-past-event';
    const isSelected = dashboardSelectedDate === dateKey;

    const dateLabel = new Date(year, month, day).toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    const eventNames = dayEvents
      .map(event => event.name || '')
      .filter(Boolean);
    const stateLabel = hasEvent ? (cancelledOnly ? ', cancelled' : hasUpcoming ? ', upcoming' : ', completed') : '';
    const eventLabel = hasEvent
      ? `, ${dayEvents.length} ${dayEvents.length === 1 ? 'event' : 'events'}${eventNames.length ? ': ' + eventNames.join(', ') : ''}`
      : '';
    const todayLabel = isToday ? ', today' : '';
    const accessibleDate = escapeHtml(dateLabel + todayLabel + eventLabel + stateLabel);
    const classes = ['calendar-cell', isToday ? 'today' : '', hasEvent ? 'has-event' : '', stateClass, isSelected ? 'is-selected' : '']
      .filter(Boolean)
      .join(' ');
    const mark = hasEvent && allEnded
      ? '<i class="bi bi-check2 calendar-cell-mark" aria-hidden="true"></i>'
      : '';

    if (hasEvent) {
      cells.push('<button type="button" class="' + classes + '" data-calendar-date="' + dateKey + '"' +
        ' aria-label="' + accessibleDate + '" aria-pressed="' + (isSelected ? 'true' : 'false') + '"' +
        ' title="' + accessibleDate + '">' + day + mark + '</button>');
    } else {
      cells.push('<span class="' + classes + '">' + day + '<span class="visually-hidden">' + accessibleDate + '</span></span>');
    }
  }

  document.getElementById('calendarMonthLabel').textContent = monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const countEl = document.getElementById('calendarEventCount');
  if (countEl) {
    const eventCount = visibleEvents.filter(event => String(event.date).slice(0, 10).startsWith(monthPrefix)).length;
    countEl.textContent = eventCount === 1 ? '1 event' : `${eventCount} events`;
  }
  calendar.innerHTML = cells.join('');
}

function loadStudentAttendance(studentId) {
  const attendance = getAttendance().filter(a => sameId(a.studentId, studentId));
  const tbody = document.getElementById('attendanceTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const events = getEvents();
  attendance.forEach(record => {
    const event = events.find(e => sameId(e.id, record.eventId)) || { name: 'Unknown Event' };
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${formatDate(record.date)}</td>
      <td>${escapeHtml(event.name)}</td>
      <td>${escapeHtml(record.time ?? '—')}</td>
      <td><span class="status-badge ${safeToken(record.status, ['present', 'late', 'absent', 'excused'])}">${escapeHtml(record.status)}</span></td>
    `;
    tbody.appendChild(row);
  });
  toggleEmptyState('emptyState', attendance.length > 0);
}

function initAttendanceCorrections() {
  const form = document.getElementById('attendanceCorrectionForm');
  const eventSelect = document.getElementById('correctionEvent');
  const timeInput = document.getElementById('correctionTime');
  const body = document.getElementById('attendanceCorrectionBody');
  const proofInput = document.getElementById('correctionProof');
  const proofPreview = document.getElementById('correctionProofPreview');
  const proofPreviewImage = document.getElementById('correctionProofImage');
  const proofClear = document.getElementById('correctionProofClear');
  if (!form || !eventSelect || !timeInput || !body) return;
  let pendingEventIds = [];
  let requestsById = {};
  let proofData = '';
  let proofBusy = false;
  let proofRequestId = 0;

  const now = new Date();
  const localToday = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const events = getEvents().filter(event => event && event.date && event.date <= localToday && event.status !== 'cancelled');
  eventSelect.innerHTML = events.length
    ? '<option value="">Choose an event</option>' + events.map(event => '<option value="' + escapeHtml(event.id) + '" data-date="' + escapeHtml(event.date) + '" data-time="' + escapeHtml(event.startTime || event.time || '08:00') + '">' + escapeHtml(event.name) + ' — ' + formatDate(event.date) + '</option>').join('')
    : '<option value="">No past events available</option>';
  eventSelect.disabled = !events.length;
  timeInput.disabled = !events.length;

  function syncSubmitState() {
    const submit = form.querySelector('[type="submit"]');
    if (!submit) return;
    const duplicate = pendingEventIds.includes(String(eventSelect.value));
    submit.disabled = !events.length || duplicate || proofBusy;
    if (duplicate) {
      submit.title = 'A correction request for this event is already pending.';
    } else if (proofBusy) {
      submit.title = 'Preparing your proof photo…';
    } else {
      submit.title = '';
    }
  }

  eventSelect.addEventListener('change', function () {
    const option = eventSelect.selectedOptions[0];
    if (option && option.dataset.date) timeInput.value = option.dataset.date + 'T' + (option.dataset.time || '08:00');
    syncSubmitState();
  });

  function clearProof() {
    proofRequestId++;
    proofData = '';
    proofBusy = false;
    if (proofInput) proofInput.value = '';
    if (proofPreview) proofPreview.classList.add('d-none');
    if (proofPreviewImage) proofPreviewImage.removeAttribute('src');
    syncSubmitState();
  }

  function proofFailure(message) {
    proofData = '';
    proofBusy = false;
    if (proofPreview) proofPreview.classList.add('d-none');
    if (proofPreviewImage) proofPreviewImage.removeAttribute('src');
    if (proofInput) {
      proofInput.value = '';
      proofInput.setCustomValidity(message);
      proofInput.reportValidity();
      proofInput.setCustomValidity('');
    }
    syncSubmitState();
  }

  /** Downscale a selected image so the data URL stays under the API's 2 MB cap. */
  function prepareProof(file) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!file || allowed.indexOf(file.type) === -1) {
      return Promise.reject(new Error('Choose a JPEG, PNG, or WebP photo.'));
    }
    if (file.size > 12 * 1024 * 1024) {
      return Promise.reject(new Error('That photo is larger than 12 MB. Choose a smaller one.'));
    }
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('The photo could not be read.')); };
      reader.onload = function () {
        const image = new Image();
        image.onerror = function () { reject(new Error('The photo could not be opened.')); };
        image.onload = function () {
          const maxSide = 1280;
          const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
          const width = Math.max(1, Math.round(image.naturalWidth * scale));
          const height = Math.max(1, Math.round(image.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) { reject(new Error('The photo could not be prepared.')); return; }
          // White backdrop keeps transparent PNGs from turning black in JPEG.
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
          const decodedBytes = Math.ceil((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4);
          if (decodedBytes > 2 * 1024 * 1024) {
            reject(new Error('The resized photo is still over 2 MB. Try a different photo.'));
            return;
          }
          resolve(dataUrl);
        };
        image.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }

  if (proofInput) {
    proofInput.addEventListener('change', function () {
      const file = proofInput.files && proofInput.files[0];
      if (!file) { clearProof(); return; }
      const requestId = ++proofRequestId;
      proofBusy = true;
      proofData = '';
      if (proofPreview) proofPreview.classList.add('d-none');
      syncSubmitState();
      prepareProof(file).then(function (dataUrl) {
        if (requestId !== proofRequestId) return;
        proofBusy = false;
        proofData = dataUrl;
        if (proofPreviewImage) proofPreviewImage.src = dataUrl;
        if (proofPreview) proofPreview.classList.remove('d-none');
        syncSubmitState();
      }).catch(function (error) {
        if (requestId !== proofRequestId) return;
        proofFailure(error.message || 'The proof photo could not be prepared.');
      });
    });
  }

  if (proofClear) proofClear.addEventListener('click', clearProof);

  async function renderRequests() {
    body.innerHTML = '<tr><td colspan="5" class="text-muted">Loading requests…</td></tr>';
    try {
      const requests = await api.listAttendanceCorrections();
      requestsById = {};
      body.innerHTML = requests.length ? requests.map(request => {
        requestsById[request.id] = request;
        const proof = request.hasProof
          ? '<button class="btn btn-sm btn-outline-secondary correction-proof-btn" type="button" data-proof-id="' + escapeHtml(String(request.id)) + '"><i class="bi bi-image" aria-hidden="true"></i> View proof</button>'
          : '<span class="correction-proof-missing"><i class="bi bi-image" aria-hidden="true"></i> No proof</span>';
        return '<tr><td>' + escapeHtml(request.eventName) + '<small class="d-block text-muted">' + escapeHtml(formatDate(request.eventDate)) + '</small></td><td>' + escapeHtml(String(request.requestedCheckInTime || '').replace('T', ' ').slice(0, 16)) + '</td><td>' + proof + '</td><td><span class="badge bg-' + (request.status === 'approved' ? 'success' : request.status === 'denied' ? 'danger' : 'secondary') + '">' + escapeHtml(request.status) + '</span></td><td>' + escapeHtml(request.reviewNotes || (request.status === 'pending' ? 'Awaiting review' : '—')) + '</td></tr>';
      }).join('') : emptyTableRow(5, 'No correction requests yet', 'Requests you submit will appear here.', 'bi-clock-history');
      pendingEventIds = requests.filter(request => request.status === 'pending').map(request => String(request.eventId));
      syncSubmitState();
    } catch (error) {
      body.innerHTML = '<tr><td colspan="5" class="text-danger">' + escapeHtml(error.message || 'Could not load correction requests.') + '</td></tr>';
    }
  }

  body.addEventListener('click', function (event) {
    const button = event.target.closest('[data-proof-id]');
    if (!button) return;
    const request = requestsById[button.dataset.proofId];
    if (!request) return;
    openAttendanceProof(request.id, request.eventName + ' · ' + formatDate(request.eventDate));
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    if (!eventSelect.value || !timeInput.value || !document.getElementById('correctionReason').value.trim()) {
      showToast('error', 'Choose an event, check-in time, and explain the correction.');
      return;
    }
    if (!proofData) {
      showToast('error', 'Upload a selfie or event photo as proof of attendance.');
      if (proofInput) proofInput.focus();
      return;
    }
    submit.disabled = true;
    try {
      await api.submitAttendanceCorrection(eventSelect.value, timeInput.value, document.getElementById('correctionReason').value.trim(), proofData);
      form.reset();
      clearProof();
      showToast('success', 'Correction request with proof sent for staff review.');
      await renderRequests();
    } catch (error) {
      showToast('error', error.message || 'The correction request could not be sent.');
      syncSubmitState();
    }
  });

  renderRequests();
}


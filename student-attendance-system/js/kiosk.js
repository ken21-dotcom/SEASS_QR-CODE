/* ============================================================
   Kiosk — officer-operated QR event check-in
   ------------------------------------------------------------
   The station is locked until an SSC officer or administrator
   signs in. After unlock it hydrates events, students, attendance
   and roster metadata from the server, then accepts QR scans.

   State machine: locked → idle → scanning → processing →
                  (success | error) → idle

   The camera reads a dynamic student QR token. The server resolves
   the token through the unique qr_token index and records attendance,
   so no camera frames or personal records are stored in the browser.

   Security: all user-supplied strings are escaped via escapeHtml()
   before being injected into innerHTML.
   ============================================================ */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Kiosk UI element references
  let els = {};
  let currentEventId = null;
  let busy = false; // true while a scan is in flight — blocks input
  let unlocked = false;
  let viewer = null;
  let idleTimer = null;
  let stationHeartbeatTimer = null;
  let scanMode = 'in'; // 'in' = check-in, 'out' = check-out
  let continuousQrText = null;
  let lastHandledQrText = '';
  let lastHandledQrScanAt = 0;
  // Keep ignoring the same code for a moment after a result, so a student
  // who leaves the QR in front of the camera does not scan twice.
  const QR_SCAN_REPEAT_WINDOW_MS = 6000;
  // Student QR codes carry the 43-character URL-safe base64 token from
  // the server (see backend/src/QrToken.php). Validating the shape here
  // rejects unrelated QR codes before an API request is made.
  const QR_TOKEN_PATTERN = /^v1\.\d{1,10}\.\d{1,10}\.[A-Za-z0-9_-]{43}$/;
  let CHECKIN_EARLY_MS = 30 * 60 * 1000;
  let CHECKIN_WINDOW_MS = 6 * 60 * 60 * 1000;
  let CHECKOUT_OPEN_MINUTES = 60;  // fallback when an event omits the offset
  let CHECKOUT_CLOSE_MINUTES = 60;
  const AUTO_LOCK_MS = 5 * 60 * 1000; // five minutes of inactivity
  const API_REQUIRED_MESSAGE =
    'Kiosk requires the API. Set API_BASE_URL in js/api.js to the local PHP endpoint ' +
    '(e.g. http://localhost:8000/api), then reload this page.';

  // Event ids are strings locally and numbers after API hydration, while
  // <select> values are always strings. Compare by text, then keep the
  // canonical id from the event object.
  const sameId = (a, b) => a != null && b != null && String(a) === String(b);

  const isOfficerRole = (role) => role === 'admin' || role === 'ssc-officer';

  const actionWord = (mode) => (mode === 'out' ? 'check-out' : 'check-in');
  const actionTitle = (mode) => (mode === 'out' ? 'Check-out' : 'Check-in');

  function checkoutWindow(event) {
    const start = parseEventDateTime(event.date, event.time);
    const hasEnd = typeof event.endTime === 'string' && event.endTime !== '';
    let end = hasEnd ? parseEventDateTime(event.date, event.endTime) : start;
    // An end time earlier than the start time runs past midnight.
    if (hasEnd && end.getTime() <= start.getTime()) {
      end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    }
    const openValue = Number(event.checkoutOpenMinutes);
    const closeValue = Number(event.checkoutCloseMinutes);
    const open = Number.isFinite(openValue) && event.checkoutOpenMinutes != null
      ? Math.max(0, openValue)
      : CHECKOUT_OPEN_MINUTES;
    const close = Number.isFinite(closeValue) && event.checkoutCloseMinutes != null
      ? Math.max(0, closeValue)
      : CHECKOUT_CLOSE_MINUTES;
    return {
      opensAt: end.getTime() - open * 60 * 1000,
      closesAt: end.getTime() + close * 60 * 1000,
    };
  }

  function initials(name) {
    return String(name || 'Officer')
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'OF';
  }

  // ── Lock / unlock ──────────────────────────────────────────────
  function setLockMessage(message) {
    if (!els.lockError) return;
    els.lockError.textContent = message || '';
    els.lockError.hidden = !message;
  }

  function setLockBusy(isBusy) {
    if (els.lockForm) els.lockForm.setAttribute('aria-busy', String(isBusy));
    if (els.lockEmail) els.lockEmail.disabled = isBusy;
    if (els.lockPassword) els.lockPassword.disabled = isBusy;
    if (els.lockSubmit) {
      els.lockSubmit.disabled = isBusy;
      els.lockSubmit.innerHTML = isBusy
        ? '<i class="bi bi-hourglass-split"></i> Unlocking…'
        : '<i class="bi bi-unlock"></i> Unlock station';
    }
  }

  function resetIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!unlocked) return;
    idleTimer = setTimeout(function () {
      lockStation('Station locked after five minutes of inactivity.', { endSession: true });
    }, AUTO_LOCK_MS);
  }

  function stopCamera(label, message, icon) {
    const scanner = window.QrScanner;
    let stopPromise = Promise.resolve();
    if (scanner && scanner.isRunning()) {
      stopPromise = scanner.stop().catch(function () {});
    }
    setCameraState(false, label || 'Station locked');
    showCameraPlaceholder(icon || 'lock', message || 'Station locked');
    return stopPromise;
  }

  /**
   * Steps are gated: only the active step is highlighted and every step
   * after it is visually disabled until its precondition is met. The kiosk
   * starts on Step 1 (select an event) and only advances to Step 2 once the
   * selected event actually accepts scans.
   */
  function setStepState(activeStep) {
    const steps = els.steps || [];
    const active = Math.min(3, Math.max(1, Number(activeStep) || 1));
    Array.prototype.forEach.call(steps, function (step, index) {
      const stepNumber = index + 1;
      const isCurrent = stepNumber === active;
      const isDisabled = stepNumber > active;
      step.classList.toggle('is-current', isCurrent);
      step.classList.toggle('is-disabled', isDisabled);
      if (isCurrent) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
      if (isDisabled) step.setAttribute('aria-disabled', 'true');
      else step.removeAttribute('aria-disabled');
      // kiosk.css has no .is-disabled rule, so grey the locked steps inline.
      step.style.opacity = isCurrent ? '1' : (isDisabled ? '.42' : '.78');
      step.style.filter = isDisabled ? 'grayscale(1)' : '';
    });
  }

  /**
   * Single source of truth for camera visibility. The camera may only run
   * while a selected event is inside its check-in/check-out window; any
   * other phase keeps the station on Step 1 with the guidance message.
   * Never runs mid-scan, so the 20-second refresh cannot interrupt a scan.
   */
  function syncCameraToEvent(phase) {
    if (!unlocked || busy) return;
    if (phase === 'live') {
      setStepState(2);
      startCamera();
      return;
    }
    setStepState(1);
    stopCamera('Camera off', 'Select a valid event to start scanning.', 'calendar2-event');
  }

  function showLock(message) {
    unlocked = false;
    viewer = null;
    currentEventId = null;
    busy = false;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (stationHeartbeatTimer) {
      clearInterval(stationHeartbeatTimer);
      stationHeartbeatTimer = null;
    }

    stopCamera();
    if (els.resultOverlay) els.resultOverlay.hidden = true;
    if (els.operator) els.operator.hidden = true;
    if (els.lock) els.lock.hidden = false;
    setLockMessage(message || '');
    setLockBusy(false);

    // Clear the previous officer's hydrated view so it cannot flash for
    // the next person who walks up to the station.
    setEvents([]);
    setUsers([]);
    setAttendance([]);
    scanMode = 'in';
    syncModeButtons();
    setModeButtonsEnabled(false);
    if (els.event) els.event.innerHTML = '<option value="">Station locked</option>';
    if (els.eventName) els.eventName.textContent = 'Station locked';
    if (els.eventMeta) els.eventMeta.textContent = 'Sign in to choose an event and start recording attendance.';
    if (els.statusChip) {
      els.statusChip.textContent = 'Locked';
      els.statusChip.className = 'kiosk-status-badge is-closed';
    }
    hideCountdown();
    setScanAvailability(false, 'Station locked', 'Sign in to unlock the scanner.');
    setStepState(1);

    setTimeout(function () {
      if (els.lockEmail) els.lockEmail.focus();
    }, 50);
  }

  function unlockUi(user) {
    viewer = user;
    unlocked = true;
    setSession(user);
    setLockMessage('');
    if (els.lock) els.lock.hidden = true;
    if (els.lockPassword) els.lockPassword.value = '';
    if (els.operator) els.operator.hidden = false;
    if (els.operatorName) els.operatorName.textContent = user.name || user.email || 'Officer';
    if (els.operatorAvatar) els.operatorAvatar.textContent = initials(user.name || user.email);
    setModeButtonsEnabled(true);
    syncModeButtons();
    setStepState(1);
    stopCamera('Camera off', 'Select a valid event to start scanning.', 'calendar2-event');
    resetIdleTimer();
    startStationHeartbeat();
  }

  function startStationHeartbeat() {
    const stationId = new URLSearchParams(window.location.search).get('station');
    if (!stationId || !/^\d+$/.test(stationId)) return;
    const sendHeartbeat = () => {
      if (!unlocked) return;
      api.heartbeatStation(stationId).catch(() => {});
    };
    sendHeartbeat();
    if (stationHeartbeatTimer) clearInterval(stationHeartbeatTimer);
    stationHeartbeatTimer = setInterval(sendHeartbeat, 60000);
  }

  function lockStation(message, options) {
    const opts = options || {};
    showLock(message);
    if (opts.endSession && isApiEnabled()) {
      // Best effort: the UI is already locked even if the server is down.
      api.logout().catch(function () {});
    }
  }

  async function signIn(rawEmail, password) {
    if (!isApiEnabled()) {
      setLockMessage(API_REQUIRED_MESSAGE);
      return;
    }

    setLockBusy(true);
    setLockMessage('');

    try {
      const user = await api.login(String(rawEmail || '').trim(), password);

      if (!isOfficerRole(user.role)) {
        await api.logout().catch(function () {});
        setLockMessage('Only SSC officers and administrators can unlock this station.');
        return;
      }
      if (user.mustChangePassword === true) {
        await api.logout().catch(function () {});
        setLockMessage('Change your temporary password in the dashboard before using this station.');
        return;
      }

      await startStation(user);
    } catch (err) {
      if (unlocked) {
        lockStation('Station locked. Sign in to resume.', { endSession: true });
      }
      setLockMessage(err && err.message ? err.message : 'Could not unlock the station. Try again.');
    } finally {
      setLockBusy(false);
      if (unlocked) setLockMessage('');
    }
  }

  async function restoreSession() {
    try {
      const result = await api.me();
      const user = result && Object.prototype.hasOwnProperty.call(result, 'user')
        ? result.user
        : result;

      if (user && isOfficerRole(user.role) && user.mustChangePassword !== true) {
        await startStation(user);
        return;
      }

      if (user) await api.logout().catch(function () {});
      showLock(user && user.role === 'student'
        ? 'Only SSC officers and administrators can unlock this station.'
        : user && user.mustChangePassword === true
          ? 'Change your temporary password in the dashboard before using this station.'
          : '');
    } catch (err) {
      showLock(err && err.code === 'network_error'
        ? 'Cannot reach the attendance server. Check the backend and try again.'
        : 'Sign in to unlock this check-in station.');
    }
  }

  // ── Server hydration ──────────────────────────────────────────
  async function hydrateKioskData() {
    // Sequential: these share one PHP session, and a 401 mid-run should
    // surface as one clean lock instead of three competing failures.
    setEvents(await api.listEvents());
    setUsers(await api.listUsers());
    setAttendance(await api.listAttendance());
  }

  async function loadHealthSettings() {
    try {
      const settings = await request('/health', { anonymous: true });
      if (Number.isFinite(settings.checkinOpenMinutesBefore)) {
        CHECKIN_EARLY_MS = Math.max(0, settings.checkinOpenMinutesBefore) * 60 * 1000;
      }
      if (Number.isFinite(settings.checkinCloseMinutesAfter)) {
        CHECKIN_WINDOW_MS = Math.max(0, settings.checkinCloseMinutesAfter) * 60 * 1000;
      }
      if (Number.isFinite(settings.checkoutOpenMinutesBeforeEnd)) {
        CHECKOUT_OPEN_MINUTES = Math.max(0, settings.checkoutOpenMinutesBeforeEnd);
      }
      if (Number.isFinite(settings.checkoutCloseMinutesAfterEnd)) {
        CHECKOUT_CLOSE_MINUTES = Math.max(0, settings.checkoutCloseMinutesAfterEnd);
      }
    } catch {
      // Keep the documented defaults when the health probe fails.
    }
  }

  async function startStation(user) {
    unlockUi(user);
    try {
      await hydrateKioskData();
      await loadHealthSettings();
      loadKioskEvents();
    } catch (err) {
      lockStation('Could not load station data. Sign in again.', { endSession: true });
      throw err;
    }
  }

  // ── Event loading ──
  function loadKioskEvents() {
    const events = (getEvents() || []).filter((e) => (e.status || 'scheduled') !== 'cancelled');
    const select = els.event;
    select.innerHTML = events.length
      ? '<option value="">Select an event</option>' + events.map((event) =>
          `<option value="${escapeHtml(event.id)}">${escapeHtml(event.name)} · ${formatDate(event.date)} · ${escapeHtml(event.time)}${event.endTime ? '–' + escapeHtml(event.endTime) : ''}</option>`
        ).join('')
      : '<option value="">No events available</option>';

    // Never auto-select an event: the officer must choose one before the
    // camera is allowed to turn on. Keep a previous choice only if it still
    // exists in the refreshed list.
    const previous = events.find((e) => sameId(e.id, currentEventId));
    currentEventId = previous ? previous.id : null;
    select.value = currentEventId != null ? String(currentEventId) : '';

    syncModeButtons();
    renderEventHeader();
    updateCounts();
    renderTicker();
  }

  function renderEventHeader() {
    const event = getEvents().find((e) => sameId(e.id, currentEventId));
    if (!event) {
      els.eventName.textContent = 'Select an event to begin';
      els.eventMeta.textContent = 'Choose an event above to start scanning.';
      els.statusChip.textContent = 'No event';
      els.statusChip.className = 'kiosk-status-badge is-closed';
      setScanAvailability(false, 'Select an event', 'Choose an active event first.');
      hideCountdown();
      if (!busy) {
        setStatus('idle', 'Select an event', 'Choose an event above to enable the camera.');
      }
      syncCameraToEvent('none');
      return;
    }

    const phase = getEventPhase(event, scanMode);
    const modeTitle = actionTitle(scanMode);
    const modeWord = actionWord(scanMode);
    els.eventName.textContent = event.name;

    const parts = [];
    parts.push(`${formatDate(event.date)} · ${event.time}${event.endTime ? '–' + event.endTime : ''}`);
    if (event.location) parts.push(event.location);
    if (event.mandatory) parts.push('Mandatory');
    else parts.push('Optional');
    els.eventMeta.textContent = parts.join(' · ');

    const statusChip = els.statusChip;
    statusChip.className = 'kiosk-status-badge is-' + phase;
    statusChip.textContent = phase === 'live' ? `${modeTitle} open`
      : phase === 'upcoming' ? `${modeTitle} soon`
      : phase === 'cancelled' ? 'Cancelled'
      : `${modeTitle} closed`;

    setScanAvailability(
      unlocked && phase === 'live',
      phase === 'live' ? 'Scanner Active'
        : phase === 'upcoming' ? `${modeTitle} opens soon` : `${modeTitle} unavailable`,
      phase === 'live' ? 'Camera ready'
        : phase === 'upcoming' ? `Please wait for the ${modeWord} window.`
        : 'Choose another active event or scan mode.'
    );
    if (!busy) {
      setStatus(
        'idle',
        phase === 'live' ? `Ready for ${modeWord}`
          : phase === 'upcoming' ? `${modeTitle} not open yet` : `${modeTitle} unavailable`,
        phase === 'live' ? 'Hold the student QR code in the frame; scanning starts automatically.'
          : phase === 'upcoming' ? `This station will unlock when ${modeWord} opens.`
          : 'Choose another active event or scan mode.'
      );
    }
    syncCameraToEvent(phase);
    renderCountdown(event, phase);
  }

  // ── Live countdown (updates every 20s) ──
  function hideCountdown() {
    els.countdown.hidden = true;
    els.countdown.innerHTML = '';
  }

  function getEventPhase(event, mode) {
    const action = mode === 'out' ? 'out' : 'in';
    if (!event || event.status === 'cancelled') return 'cancelled';
    if (event.status === 'completed') return 'closed';
    const now = new Date();
    if (action === 'out') {
      const { opensAt, closesAt } = checkoutWindow(event);
      if (now.getTime() < opensAt) return 'upcoming';
      if (now.getTime() > closesAt) return 'closed';
      return 'live';
    }
    const start = parseEventDateTime(event.date, event.time);
    if (now.getTime() < start.getTime() - CHECKIN_EARLY_MS) return 'upcoming';
    if (now.getTime() > start.getTime() + CHECKIN_WINDOW_MS) return 'closed';
    return 'live';
  }

  function setScanAvailability(enabled, title, detail) {
    els.scanBtn.classList.toggle('is-inactive', !enabled);
    els.scanBtn.setAttribute('aria-label', title);
    if (els.scanCtaTitle) els.scanCtaTitle.textContent = title;
    if (els.scanCtaDetail) els.scanCtaDetail.textContent = detail;
    if (els.manualInput) els.manualInput.disabled = !enabled;
    if (els.manualSubmit) els.manualSubmit.disabled = !enabled;
  }

  function syncModeButtons() {
    [[els.modeIn, 'in'], [els.modeOut, 'out']].forEach(([button, mode]) => {
      if (!button) return;
      const active = scanMode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function setModeButtonsEnabled(enabled) {
    [els.modeIn, els.modeOut].forEach((button) => {
      if (button) button.disabled = !enabled;
    });
  }

  /** Switch the station between recording arrivals and departures. */
  function setScanMode(mode) {
    if (busy) return;
    scanMode = mode === 'out' ? 'out' : 'in';
    syncModeButtons();
    if (unlocked) {
      renderEventHeader();
      resetIdleTimer();
    }
  }

  function renderCountdown(event, phase) {
    const el = els.countdown;
    el.hidden = false;
    el.dataset.phase = phase;
    const now = new Date();
    const modeTitle = actionTitle(scanMode);
    const start = parseEventDateTime(event.date, event.time);
    const window = scanMode === 'out' ? checkoutWindow(event) : null;

    if (phase === 'cancelled') {
      el.innerHTML = '<i class="bi bi-x-circle"></i> This event has been cancelled';
    } else if (phase === 'closed') {
      el.innerHTML = `<i class="bi bi-lock"></i> ${modeTitle} window has closed`;
    } else if (phase === 'upcoming') {
      const opensAt = window ? window.opensAt : start.getTime() - CHECKIN_EARLY_MS;
      const diff = Math.max(0, opensAt - now.getTime());
      const days = Math.ceil(diff / 86400000);
      const label = diff > 86400000 ? (days + (days === 1 ? ' day' : ' days')) : formatCountdown(diff);
      el.innerHTML = `<i class="bi bi-hourglass-split"></i> ${modeTitle} opens in ${label}`;
    } else {
      const closesAt = window ? window.closesAt : start.getTime() + CHECKIN_WINDOW_MS;
      const remaining = closesAt - now.getTime();
      el.innerHTML = `<i class="bi bi-broadcast"></i> ${modeTitle} open now · closes in ${formatCountdown(remaining)}`;
    }
  }

  /** "HH:MM" (local) + "YYYY-MM-DD" -> Date */
  function parseEventDateTime(dateStr, timeStr) {
    const d = new Date(dateStr + 'T' + timeStr);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  function formatCountdown(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  // ── Live counts — checked-in / enrolled / attendance % ──
  function updateCounts() {
    const attendance = getAttendance();
    const checkedIn = currentEventId
      ? attendance.filter((a) => sameId(a.eventId, currentEventId) && (a.status === 'present' || a.status === 'late')).length
      : 0;

    els.count.textContent = checkedIn;

    // Every active student can present a QR code, so the roster count is
    // the number of active student accounts returned by the server.
    const roster = (getUsers() || []).filter((u) =>
      u.role === 'student' && (u.status === undefined || u.status === 'active')
    ).length;
    els.listCount.textContent = roster;

    // Attendance % = checked-in / active students (manual entries can
    // exceed the roster count, so cap the display at 100%).
    const denom = roster || 1;
    els.attendancePct.textContent = Math.min(100, Math.round((checkedIn / denom) * 100)) + '%';
  }

  // ── Recent attendance ticker (last N successful scans for this event) ──
  const TICKER_MAX = 4;

  function renderTicker() {
    if (!els.ticker) return;
    const attendance = getAttendance();
    const recent = currentEventId
      ? attendance.filter((a) => sameId(a.eventId, currentEventId) && (a.status === 'present' || a.status === 'late'))
      : [];
    // Seed data may have no time; newest first.
    const sorted = recent.slice().sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    const latest = sorted.slice(0, TICKER_MAX);

    if (!latest.length) {
      els.ticker.hidden = true;
      return;
    }
    els.ticker.hidden = false;

    const users = getUsers();
    els.tickerList.innerHTML = latest.map((a) => {
      const student = users.find((u) => String(u.id) === String(a.studentId));
      const name = a.studentName || (student ? student.name : 'Student');
      const initialsText = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
      const firstName = name.split(' ')[0];
      const wentOut = a.checkedOut === true;
      return (
        `<div class="kiosk-ticker-item">` +
          `<span class="kiosk-ticker-avatar">${escapeHtml(initialsText)}</span>` +
          `<span class="kiosk-ticker-info">` +
            `<span class="kiosk-ticker-name">${escapeHtml(firstName)} checked ${wentOut ? 'out' : 'in'}</span>` +
            `<span class="kiosk-ticker-time">${escapeHtml(wentOut ? (a.checkOutTimeLabel || a.time) : (a.time || 'now'))}</span>` +
          `</span>` +
          `<i class="bi bi-check-circle-fill kiosk-ticker-check" aria-hidden="true"></i>` +
        `</div>`
      );
    }).join('');
  }

  // ── Status rendering — drives the kiosk scan panel ──
  function setStatus(state, text, hint) {
    const scanner = els.scanner;
    scanner.dataset.state = state;
    scanner.setAttribute('aria-busy', String(state === 'scanning' || state === 'processing'));
    if (text !== undefined) els.statusText.textContent = text;
    if (hint !== undefined) els.scanHint.textContent = hint;
  }

  /**
   * Append the server's attendance row to the local cache used by the
   * counters and ticker. The server row is authoritative; we only add
   * presentation flags the reports expect.
   */
  function addServerRecord(record, eventId) {
    const attendance = getAttendance().filter((a) =>
      !(sameId(a.eventId, eventId) && String(a.studentId) === String(record.studentId))
    );
    attendance.push(Object.assign({ excused: false, excuseReason: '' }, record, {
      eventId: eventId,
      method: record.verificationMethod || 'qr',
    }));
    setAttendance(attendance);
    updateCounts();
    renderTicker();
  }

  function isSessionError(err) {
    if (!err) return false;
    return err.status === 401 ||
      err.status === 403 ||
      err.code === 'unauthenticated' ||
      err.code === 'forbidden' ||
      err.code === 'password_change_required';
  }

  // ── Result overlay (success / error) ──
  const RESULT_ICONS = {
    success:            'check-circle-fill',
    'already':          'exclamation-triangle-fill',
    'no-match':         'x-circle-fill',
    'no-qr':            'x-circle-fill',
    'permission-denied': 'camera-video-fill',
    'device-error':     'x-circle-fill',
    'model-error':      'x-circle-fill',
    'server-error':     'x-circle-fill',
    'no-event':         'info-circle-fill',
    'invalid_qr':       'qr-code-scan',
  };

  function showResult(type, title, message, meta) {
    // Set the state class on the wrapper (drives gradient disc colors)
    // and a stable icon class on the inner <i> (drives glyph + white text).
    const wrap = els.resultIconWrap || els.resultIcon.parentElement;
    wrap.className = `kiosk-result-icon-wrap is-${type}`;
    els.resultIcon.className = `bi bi-${RESULT_ICONS[type] || 'info-circle-fill'} kiosk-result-icon`;
    els.resultTitle.textContent = title;
    els.resultMessage.textContent = message;
    // meta is controlled HTML from our code — safe to use innerHTML
    els.resultMeta.innerHTML = meta || '';
    els.resultOverlay.hidden = false;
    els.resultDone.focus();
  }

  // ── Camera status / lifecycle ──
  function setCameraState(online, label) {
    if (els.stationState) els.stationState.textContent = label;
    if (els.stationDot) els.stationDot.classList.toggle('is-offline', !online);
  }

  function showCameraPlaceholder(icon, message) {
    if (!els.cameraPlaceholder) return;
    els.cameraPlaceholder.hidden = false;
    els.cameraPlaceholder.innerHTML = `<i class="bi bi-${icon}"></i><span>${escapeHtml(message)}</span>`;
  }

  /**
   * Analyse a decoded QR payload before it is sent to the server.
   *
   * A student dashboard QR contains an event-scoped token
   * (v1.<studentId>.<eventId>.<signature>), but some phone camera apps wrap
   * the text in a URL. Both shapes are understood here; everything else is
   * rejected locally so random QR codes never reach the attendance endpoint.
   */
  function analyzeQrText(rawText) {
    let candidate = String(rawText == null ? '' : rawText)
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();

    if (/^https?:\/\//i.test(candidate)) {
      try {
        const url = new URL(candidate);
        candidate = url.searchParams.get('qrToken')
          || url.searchParams.get('token')
          || '';
      } catch (error) {
        candidate = '';
      }
    }

    candidate = candidate.trim();
    return {
      valid: QR_TOKEN_PATTERN.test(candidate),
      token: candidate,
    };
  }

  function handleContinuousQrScan(rawText) {
    if (!unlocked || !rawText) return;
    if (busy) return;
    // A result is on screen. Ignore the code still in front of the
    // camera so the same scan cannot loop while it is being read.
    if (els.resultOverlay && !els.resultOverlay.hidden) return;

    const text = String(rawText);
    const now = Date.now();
    if (text === lastHandledQrText && now - lastHandledQrScanAt < QR_SCAN_REPEAT_WINDOW_MS) {
      return;
    }

    const event = getEvents().find((e) => sameId(e.id, currentEventId));
    if (!event || getEventPhase(event, scanMode) !== 'live') return;

    lastHandledQrText = text;
    lastHandledQrScanAt = now;
    continuousQrText = text;
    runQrScan();
  }

  async function ensureCamera() {
    const scanner = window.QrScanner;
    if (!scanner) {
      const err = new Error('QR scanner module unavailable.');
      err.code = 'model-error';
      throw err;
    }
    if (scanner.isRunning()) {
      setCameraState(true, 'Camera online');
      if (els.cameraPlaceholder) els.cameraPlaceholder.hidden = true;
      return;
    }
    setCameraState(false, 'Starting camera…');
    await scanner.start(handleContinuousQrScan, function (code) {
      if (code === 'permission-denied' || code === 'device-error') {
        setStatus('attention', 'Camera unavailable', 'Allow camera access and keep this station unlocked.');
      }
    });
    setCameraState(true, 'Camera online');
    setStatus('scanning', 'Scanner active', 'Hold the student QR code in front of the camera.');
    if (els.cameraPlaceholder) els.cameraPlaceholder.hidden = true;
  }

  function startCamera() {
    if (!unlocked) return;
    if (!window.QrScanner) {
      setCameraState(false, 'QR scanner module missing');
      showCameraPlaceholder('qr-code-scan', 'QR scanner module missing');
      return;
    }
    ensureCamera()
      .catch((err) => {
        const denied = err && err.code === 'permission-denied';
        const cameraDetail = err && err.message ? err.message : '';
        console.error('[Kiosk] Camera startup failed:', err && err.name, err && err.message);
        setCameraState(false, denied ? 'Camera permission blocked' : 'Camera offline');
        showCameraPlaceholder(
          'camera-video-off',
          denied ? 'Allow camera access to scan QR codes' : 'Camera unavailable — use manual entry'
        );
        if (!busy) {
          setStatus(
            'attention',
            denied ? 'Camera blocked' : 'Camera unavailable',
            denied
              ? 'Allow camera access in your browser, then reselect the event.'
              : (cameraDetail ? `${cameraDetail} — close other apps, check Windows camera access, then reselect the event.` : 'Close other apps using the camera, then reselect the event to retry.')
          );
        }
      });
  }

  // ── QR check-in flow (server-verified) ──
  async function runQrScan() {
    if (!isApiEnabled()) {
      showApiRequired();
      return;
    }
    const predecodedText = continuousQrText;
    continuousQrText = null;
    if (!unlocked) {
      showLock('Sign in to unlock this station.');
      return;
    }
    if (busy) return;
    const event = getEvents().find((e) => sameId(e.id, currentEventId));
    if (!event) {
      showResult('no-event', 'No event selected', 'Choose an event before scanning.', '');
      return;
    }
    const modeTitle = actionTitle(scanMode);
    const modeWord = actionWord(scanMode);
    if (getEventPhase(event, scanMode) !== 'live') {
      showResult(
        'no-event',
        `${modeTitle} unavailable`,
        `This event is not accepting ${modeWord}s right now.`,
        `Choose an event or mode marked “${modeTitle} open”.`
      );
      return;
    }

    // Analyse the decoded payload before calling the server. Only the
    // token itself leaves the browser; camera frames never do.
    const analysis = analyzeQrText(predecodedText);
    if (!analysis.valid) {
      console.debug('[Kiosk] Ignored QR payload with an invalid token shape.');
      lastHandledQrText = String(predecodedText || '');
      lastHandledQrScanAt = Date.now();
      showResult(
        'invalid_qr',
        'Not an Attendly QR code',
        'This is not a student check-in code. Please use the QR code from the student dashboard.',
        ''
      );
      setStatus('attention', 'QR code not recognised', 'Scan the QR code shown on the student dashboard.');
      return;
    }

    const decoded = analysis.token;
    busy = true;
    resetIdleTimer();
    els.resultOverlay.hidden = true;
    setStepState(3);
    setStatus('processing', 'Verifying QR', 'The server is checking this code against your enrollment.');

    try {
      // The browser sends only the QR token text. The server looks it
      // up by unique index and returns the student's name.
      const record = await api.qrCheckIn(event.id, decoded, scanMode);
      const action = record.action === 'out' ? 'out' : 'in';
      const studentName = record.studentName || 'Student';
      addServerRecord(record, event.id);
      const stamp = action === 'out'
        ? (record.checkOutTimeLabel || record.time)
        : record.time;
      showResult(
        'success',
        action === 'out' ? `Goodbye, ${studentName}!` : `Welcome, ${studentName}!`,
        action === 'out' ? 'Check-out recorded.' : 'Attendance recorded.',
        `<strong>${escapeHtml(event.name)}</strong> · ${escapeHtml(stamp || new Date().toLocaleTimeString())}`
      );
      setStatus(
        'success',
        action === 'out' ? 'Checked out' : 'Checked in',
        action === 'out' ? 'Check-out saved. You can go ahead.' : 'Attendance saved. You can go ahead.'
      );
      resetIdleTimer();
    } catch (err) {
      if (isSessionError(err)) {
        lockStation('Station locked. Officer session expired — sign in again.', { endSession: true });
        return;
      }

      const code = err.code || 'device-error';
      const map = {
        'duplicate_checkin': ['Already checked in', 'This student is already checked in for this event.'],
        'duplicate_checkout': ['Already checked out', 'This student has already checked out for this event.'],
        'not_checked_in':    ['Not checked in', 'This student has no check-in for this event, so there is nothing to check out.'],
        'checkin_closed':    ['Check-in closed', 'This event is outside its check-in window.'],
        'checkout_closed':   ['Check-out closed', 'This event is outside its check-out window.'],
        'event_unavailable': ['Attendance unavailable', 'This event is not accepting attendance right now.'],
        'event_not_found':   ['Event not found', 'The selected event no longer exists. Refresh the event list.'],
        'invalid_field':     ['Scan rejected', 'The scan could not be verified. Try again in better light.'],
        'rate_limited':      ['Please wait', 'Too many scans were sent at once. Try again in a moment.'],
        'network_error':     ['Server unreachable', 'The attendance server did not respond. Check the connection and try again.'],
        'permission-denied': ['Camera blocked', 'Allow camera access in your browser, then reselect the event to retry.'],
        'device-error':      ['Camera unavailable', 'Close other apps using the camera and try again, or use manual entry.'],
        'model-error':       ['QR scanner unavailable', 'The QR scanner library could not load. Serve the kiosk on localhost and refresh the page.'],
        'no-qr':             ['No QR code detected', 'Hold your check-in QR code in front of the camera.'],
        'invalid_qr':        ['Invalid QR code', 'This code is not a valid check-in code. Use the code from your dashboard.'],
        'invalid_qr_event':  ['Wrong event QR code', 'This QR code belongs to a different event. Select the event on the student dashboard and scan the new code.'],
      };
      if (code === 'duplicate_checkin' || code === 'duplicate_checkout' || code === 'not_checked_in') {
        showResult('already', map[code][0], map[code][1], '');
        setStatus('attention', map[code][0], 'No action needed.');
        return;
      }
      if (code === 'checkin_closed' || code === 'checkout_closed' || code === 'event_unavailable' || code === 'event_not_found') {
        showResult('no-event', map[code][0], map[code][1], '');
        setStatus('error', map[code][0], 'Choose another event, scan mode, or ask the SSC officer.');
        return;
      }
      const [title, message] = map[code] || ['Scan failed', 'Something went wrong. Try again or use manual entry.'];
      const type = map[code] ? code : 'device-error';
      showResult(type, title, message, '');
      setStatus(
        'error',
        title,
        'Use manual entry below if this keeps happening.'
      );

      if (code === 'permission-denied' || code === 'device-error') {
        setCameraState(false, 'Camera offline');
        showCameraPlaceholder('camera-video-off', 'Camera unavailable — use manual entry');
      }
    } finally {
      busy = false;
      // Keep the camera running between successful scans. It is stopped
      // only by station lock/event lifecycle logic.
      const activeEvent = getEvents().find((e) => sameId(e.id, currentEventId));
      syncCameraToEvent(activeEvent ? getEventPhase(activeEvent, scanMode) : 'none');
      resetIdleTimer();
    }
  }

  // ── Manual fallback (server-authorized override) ──
  async function runManualEntry(rawId) {
    if (!isApiEnabled()) {
      showApiRequired();
      return;
    }
    if (!unlocked) {
      showLock('Sign in to unlock this station.');
      return;
    }
    const id = (rawId || '').trim();
    const event = getEvents().find((e) => sameId(e.id, currentEventId));
    if (!event || !id) return;
    const modeTitle = actionTitle(scanMode);
    const modeWord = actionWord(scanMode);
    if (getEventPhase(event, scanMode) !== 'live') {
      showToast('warning', `This event is not accepting ${modeWord}s right now.`);
      return;
    }

    const needle = id.toLowerCase();
    const student = getUsers().find((u) =>
      u.role === 'student' && (
        String(u.id) === id ||
        String(u.studentIdNumber || '').toLowerCase() === needle ||
        String(u.email || '').toLowerCase() === needle
      )
    );
    if (!student) {
      showToast('error', 'Student not found.');
      return;
    }

    const studentName = student.name || 'Student';
    busy = true;
    resetIdleTimer();
    try {
      const record = await api.manualCheckIn(event.id, student.id, scanMode);
      const action = record.action === 'out' ? 'out' : 'in';
      addServerRecord(record, event.id);
      const stamp = action === 'out'
        ? (record.checkOutTimeLabel || record.time)
        : record.time;
      showResult(
        'success',
        action === 'out' ? `Goodbye, ${studentName}!` : `Welcome, ${studentName}!`,
        action === 'out' ? 'Manual check-out recorded.' : 'Manual attendance recorded.',
        `<strong>${escapeHtml(event.name)}</strong> · ${escapeHtml(stamp || new Date().toLocaleTimeString())}`
      );
      showToast(
        'success',
        action === 'out' ? `${studentName} checked out.` : `${studentName} checked in.`
      );
    } catch (err) {
      if (isSessionError(err)) {
        lockStation('Station locked. Officer session expired — sign in again.', { endSession: true });
        return;
      }
      if (err.code === 'duplicate_checkin' || err.code === 'duplicate_checkout') {
        const already = err.code === 'duplicate_checkout' ? 'checked out' : 'checked in';
        showToast('warning', `${studentName} is already ${already}.`);
        showResult('already', `Already ${already}`, `${studentName} is already ${already} for this event.`, '');
        return;
      }
      if (err.code === 'not_checked_in') {
        showToast('warning', `${studentName} has not checked in yet.`);
        showResult('already', 'Not checked in', `${studentName} has no check-in for this event, so there is nothing to check out.`, '');
        return;
      }
      showToast('error', `The server did not record this ${modeWord}. Please retry.`);
      showResult('server-error', 'Server unreachable', `The attendance server did not accept this ${modeWord}. Please retry, or see the SSC booth.`, '');
    } finally {
      busy = false;
      resetIdleTimer();
    }
  }

  // ── Clock ──
  function tickClock() {
    const now = new Date();
    els.clockTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    els.clockDate.textContent = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function showApiRequired() {
    els.event.innerHTML = '<option value="">API required</option>';
    els.event.disabled = true;
    els.eventName.textContent = 'Kiosk API not configured';
    els.eventMeta.textContent = API_REQUIRED_MESSAGE;
    els.statusChip.textContent = 'API required';
    els.statusChip.className = 'kiosk-status-badge is-closed';
    hideCountdown();
    setScanAvailability(false, 'API required', 'Set API_BASE_URL in js/api.js, then reload.');
    setModeButtonsEnabled(false);
    setStatus('error', 'API required', 'Set API_BASE_URL in js/api.js, then reload this page.');
    setCameraState(false, 'API required');
    showCameraPlaceholder('exclamation-triangle', 'API not configured');
    if (els.manualToggle) {
      els.manualToggle.disabled = true;
      els.manualToggle.setAttribute('aria-expanded', 'false');
    }
    if (els.manualBody) els.manualBody.hidden = true;
    if (els.manualId) els.manualId.placeholder = 'API required';
    setLockMessage(API_REQUIRED_MESSAGE);
    setLockBusy(true);
  }

  // ── Boot ──
  function init() {
    els = {
      event:        $('kioskEvent'),
      eventName:    $('kioskEventName'),
      eventMeta:    $('kioskEventMeta'),
      countdown:    $('kioskCountdown'),
      statusChip:   $('kioskStatusBadge'),
      modeIn:       $('kioskModeIn'),
      modeOut:      $('kioskModeOut'),
      scanner:      $('kioskScanner'),
      statusText:   $('kioskStatusText'),
      scanHint:     $('kioskScanHint'),
      steps:        document.querySelectorAll('.kiosk-steps li'),
      scanBtn:      $('kioskScanBtn'),
      scanCtaTitle: document.querySelector('.kiosk-scan-cta strong'),
      scanCtaDetail: document.querySelector('.kiosk-scan-cta small'),
      count:        $('kioskCount'),
      listCount:    $('kioskListCount'),
      attendancePct: $('kioskAttendancePct'),
      ticker:       $('kioskTicker'),
      tickerList:   $('kioskTickerList'),
      resultOverlay: $('resultOverlay'),
      resultIconWrap: $('resultIconWrap'),
      resultIcon:   $('resultIcon'),
      resultTitle:  $('resultTitle'),
      resultMessage: $('resultMessage'),
      resultMeta:   $('resultMeta'),
      resultDone:   $('resultDone'),
      manualToggle: $('manualToggle'),
      manualBody:   $('manualBody'),
      manualForm:   $('kioskManualForm'),
      manualId:     $('manualStudentId'),
      manualInput:  $('manualStudentId'),
      manualSubmit: document.querySelector('#kioskManualForm button[type="submit"]'),
      camera:       $('kioskCamera'),
      cameraPlaceholder: $('kioskCameraPlaceholder'),
      stationState: $('kioskStationState'),
      stationDot:   $('kioskStationDot'),
      clockTime:    $('kioskClockTime'),
      clockDate:    $('kioskClockDate'),
      lock:         $('kioskLock'),
      lockForm:     $('kioskLockForm'),
      lockEmail:    $('kioskLockEmail'),
      lockPassword: $('kioskLockPassword'),
      lockSubmit:   $('kioskLockSubmit'),
      lockError:    $('kioskLockError'),
      operator:     $('kioskOperator'),
      operatorName: $('kioskOperatorName'),
      operatorAvatar: $('kioskOperatorAvatar'),
      lockNow:      $('kioskLockNow'),
    };

    tickClock();
    setInterval(tickClock, 1000);

    if (!isApiEnabled()) {
      showApiRequired();
      return;
    }

    // Lock-screen sign-in.
    els.lockForm.addEventListener('submit', (e) => {
      e.preventDefault();
      signIn(els.lockEmail.value, els.lockPassword.value);
    });

    if (els.lockNow) {
      els.lockNow.addEventListener('click', () => {
        lockStation('Station locked by the officer.', { endSession: true });
      });
    }

    // Any deliberate interaction postpones the inactivity lock.
    ['pointerdown', 'keydown', 'touchstart'].forEach((eventName) => {
      document.addEventListener(eventName, () => {
        if (unlocked && !busy) resetIdleTimer();
      }, { passive: true });
    });

    els.event.addEventListener('change', async () => {
      const chosen = getEvents().find((e) => sameId(e.id, els.event.value));
      if (!sameId(currentEventId, chosen && chosen.id)) {
        await stopCamera('Camera switching', 'Changing event. The scanner will restart automatically.', 'calendar2-event');
      }
      currentEventId = chosen ? chosen.id : null;
      renderEventHeader();
      updateCounts();
      renderTicker();
      resetIdleTimer();
    });

    [[els.modeIn, 'in'], [els.modeOut, 'out']].forEach(([button, mode]) => {
      if (!button) return;
      button.addEventListener('click', () => setScanMode(mode));
    });

    // Manual entry collapse
    if (els.manualToggle) {
      els.manualToggle.addEventListener('click', () => {
        const expanded = els.manualToggle.getAttribute('aria-expanded') === 'true';
        els.manualToggle.setAttribute('aria-expanded', String(!expanded));
        els.manualBody.hidden = expanded;
        resetIdleTimer();
      });
    }

    if (els.manualForm) {
      els.manualForm.addEventListener('submit', (e) => {
        e.preventDefault();
        // Awaited via .catch so a rejected server call surfaces on the
        // kiosk rather than as an unhandled promise rejection.
        runManualEntry(els.manualId.value).catch(() => {
          showToast('error', `The server did not record this ${actionWord(scanMode)}. Please retry.`);
          showResult('server-error', 'Server unreachable', `The attendance server did not accept this ${actionWord(scanMode)}. Please retry, or see the SSC booth.`, '');
        });
        els.manualId.value = '';
      });
    }

    if (els.resultDone) {
      els.resultDone.addEventListener('click', () => {
        els.resultOverlay.hidden = true;
        // The student may still be holding the same QR code. Restart the
        // repeat window so it is not recorded twice in a row.
        lastHandledQrScanAt = Date.now();
        setStatus('idle', `Waiting for ${actionWord(scanMode)}`, `Hold the student QR code in the frame to ${actionWord(scanMode)}.`);
        resetIdleTimer();
      });
    }

    showLock('Sign in to unlock this check-in station.');
    restoreSession();

    // Refresh the countdown periodically once unlocked.
    setInterval(() => {
      if (unlocked) renderEventHeader();
    }, 20000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();

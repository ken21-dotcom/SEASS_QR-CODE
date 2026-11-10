/* ============================================================
   SSC Officer — all ssc-officer page logic
   ------------------------------------------------------------
   Loaded only by pages/ssc-officer/*.html. Administrator pages
   load administrator-panel.js instead.
   ============================================================ */

document.addEventListener('DOMContentLoaded', async function() {
  const user = await requireServerAuth('ssc-officer');
  if (!user) return;

  const sscNav = document.querySelector('.role-nav[aria-label="SSC navigation"]');

  if (document.getElementById('attendanceCorrectionsBody')) {
    initAttendanceCorrectionReview();
  }

  if (document.getElementById('reportEvent') && window.ReportsPage) {
    await window.ReportsPage.init();
  }

  // Dashboard stats
  if (document.getElementById('statTotalEvents')) {
    loadDashboardStats();
  }

  // Manage students — grouped by Department → Course → Year Level, read-only.
  if (document.getElementById('studentTableBody')) {
    initGroupedStudentList({
      tbodyId: 'studentTableBody',
      countId: 'studentCount',
      departmentFilterId: 'filterDepartment',
      courseFilterId: 'filterCourse',
      yearFilterId: 'filterYear',
      searchId: 'studentSearch',
      colspan: 5,
      renderRow: (student) =>
        `<td>${escapeHtml(student.name)}</td>` +
        `<td>${escapeHtml(student.studentIdNumber || student.id)}</td>` +
        `<td>${escapeHtml(student.email)}</td>` +
        `<td>${yearBadge(student)}</td>` +
        `<td>${escapeHtml(student.block || '—')}</td>`,
    });
  }

  // Manage events
  if (document.getElementById('eventTableBody')) {
    loadEventsTable();
    bindEventFormHandlers();
  }

  // FR12: report screens are owned by reports.js (ReportsPage).
});

async function initAttendanceCorrectionReview() {
  const tbody = document.getElementById('attendanceCorrectionsBody');
  if (!tbody) return;
  let proofRequests = {};

  function showProof(id) {
    const request = proofRequests[id];
    if (!request) {
      showToast('error', 'This request is no longer available.');
      return;
    }
    openAttendanceProof(id, request.studentName + ' · ' +
      (request.eventPublicId ? request.eventPublicId + ' — ' : '') +
      request.eventName + ' · ' + formatDate(request.eventDate));
  }

  const denyModalEl = document.getElementById('denyRequestModal');
  const denyInput = document.getElementById('denyReasonInput');
  const denyError = document.getElementById('denyReasonError');
  const denyConfirm = document.getElementById('denyRequestConfirm');
  let pendingDenyId = null;

  function denyModalInstance() {
    return denyModalEl && window.bootstrap ? bootstrap.Modal.getOrCreateInstance(denyModalEl) : null;
  }

  function resetDenyForm() {
    pendingDenyId = null;
    if (denyInput) {
      denyInput.value = '';
      denyInput.classList.remove('is-invalid');
    }
    if (denyError) denyError.textContent = '';
    if (denyConfirm) denyConfirm.disabled = false;
  }

  function denyFailure(message) {
    if (denyError) denyError.textContent = message;
    if (denyInput) {
      denyInput.classList.add('is-invalid');
      denyInput.focus();
    }
    if (denyConfirm) denyConfirm.disabled = false;
  }

  function openDenyModal(id) {
    pendingDenyId = id;
    if (denyInput) {
      denyInput.value = '';
      denyInput.classList.remove('is-invalid');
    }
    if (denyError) denyError.textContent = '';
    if (denyConfirm) denyConfirm.disabled = false;
    const modal = denyModalInstance();
    if (modal) modal.show();
  }

  if (denyInput) {
    denyInput.addEventListener('input', () => {
      denyInput.classList.remove('is-invalid');
      if (denyError) denyError.textContent = '';
    });
  }

  if (denyModalEl) {
    denyModalEl.addEventListener('shown.bs.modal', () => {
      if (denyInput) denyInput.focus();
    });
    denyModalEl.addEventListener('hidden.bs.modal', resetDenyForm);
  }

  if (denyConfirm) {
    denyConfirm.addEventListener('click', async () => {
      const notes = denyInput ? denyInput.value.trim() : '';
      if (!notes) {
        denyFailure('Enter a reason before denying this request.');
        return;
      }
      if (pendingDenyId === null) {
        denyFailure('Select a correction request first.');
        return;
      }
      denyConfirm.disabled = true;
      if (denyError) denyError.textContent = '';
      try {
        await api.reviewAttendanceCorrection(pendingDenyId, 'denied', notes);
        const modal = denyModalInstance();
        if (modal) modal.hide();
        showToast('success', 'Correction request denied.');
        await render();
        await hydrateFromApi();
      } catch (error) {
        denyFailure(error.message || 'Request could not be reviewed.');
      }
    });
  }

  async function render() {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted">Loading requests…</td></tr>';
    try {
      const rows = await api.listAttendanceCorrections();
      proofRequests = {};
      tbody.innerHTML = rows.length ? rows.map(request => {
        proofRequests[request.id] = request;
        const action = request.status === 'pending'
          ? '<div class="table-actions"><button class="btn btn-sm btn-success" type="button" data-correction-decision="approved" data-id="' + request.id + '"><i class="bi bi-check-lg" aria-hidden="true"></i> Approve &amp; apply</button><button class="btn btn-sm btn-outline-danger" type="button" data-correction-decision="denied" data-id="' + request.id + '"><i class="bi bi-x-lg" aria-hidden="true"></i> Deny</button></div>'
          : '<span class="text-muted">' + escapeHtml(request.reviewNotes || 'Reviewed') + '</span>';
        const proof = request.hasProof
          ? '<button class="btn btn-sm btn-outline-secondary correction-proof-btn" type="button" data-proof-id="' + request.id + '"><i class="bi bi-image" aria-hidden="true"></i> View proof</button>'
          : '<span class="correction-proof-missing"><i class="bi bi-image" aria-hidden="true"></i> No proof</span>';
        return '<tr><td>' + escapeHtml(request.studentName) + '<small class="d-block text-muted">' + escapeHtml(request.studentIdNumber) + '</small></td><td>' + escapeHtml(request.eventName) + (request.eventPublicId ? '<small class="d-block text-muted">' + escapeHtml(request.eventPublicId) + '</small>' : '') + '<small class="d-block text-muted">' + escapeHtml(formatDate(request.eventDate)) + '</small></td><td>' + escapeHtml(String(request.requestedCheckInTime || '').replace('T', ' ').slice(0, 16)) + '<small class="d-block text-muted">Current: ' + escapeHtml(request.currentCheckInTime ? String(request.currentCheckInTime).slice(0, 16) : 'No record') + '</small></td><td>' + escapeHtml(request.reason) + '</td><td>' + proof + '</td><td><span class="badge bg-' + (request.status === 'approved' ? 'success' : request.status === 'denied' ? 'danger' : 'secondary') + '">' + escapeHtml(request.status) + '</span></td><td>' + action + '</td></tr>';
      }).join('') : emptyTableRow(7, 'No correction requests', 'Student requests will appear here.', 'bi-clock-history');
    } catch (error) { tbody.innerHTML = '<tr><td colspan="7" class="text-danger">' + escapeHtml(error.message || 'Could not load requests.') + '</td></tr>'; }
  }
  tbody.addEventListener('click', async event => {
    const proofButton = event.target.closest('[data-proof-id]');
    if (proofButton) {
      showProof(proofButton.dataset.proofId);
      return;
    }
    const button = event.target.closest('[data-correction-decision]');
    if (!button) return;
    const decision = button.dataset.correctionDecision;
    if (decision === 'denied') {
      openDenyModal(button.dataset.id);
      return;
    }
    button.disabled = true;
    try {
      await api.reviewAttendanceCorrection(button.dataset.id, decision, '');
      showToast('success', 'Attendance updated from the reviewed request.');
      await render();
      await hydrateFromApi();
    } catch (error) { showToast('error', error.message || 'Request could not be reviewed.'); button.disabled = false; }
  });
  render();
}


function loadDashboardStats() {
  // Dashboard stats are rendered by the inline script in ssc-dashboard.html.
  // The data is sourced from getEvents(), getAttendance(), and getUsers()
  // which read from localStorage - hydrated from the API on login via hydrateFromApi().
  //
  // Backend data shapes:
  // - GET /events returns: id, publicId, name, date, time, location, status, etc.
  // - GET /attendance returns: id, eventId, studentId, date, time, status (present/late), etc.
  // - GET /users returns: id, role, status, name, etc.
  //
  // The hydration happens automatically after successful login in api.js.
}

function loadEventsTable() {
  const events = getEvents();
  const tbody = document.getElementById('eventTableBody');
  if (!tbody) return;
  if (!events.length) {
    tbody.innerHTML = emptyTableRow(6, 'No events yet', 'Create an event to start tracking attendance.', 'bi-calendar-plus');
    return;
  }
  tbody.innerHTML = '';
  events.forEach(event => {
    const type = event.type || 'minor';
    const mandatory = event.mandatory;
    const recurring = event.recurring;
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(event.name)}</td>
      <td>${formatDate(event.date)}</td>
      <td>${escapeHtml(event.time)}</td>
      <td>${escapeHtml(event.location)}</td>
      <td>
        <div class="event-badges">
          <span class="event-type-badge ${safeToken(type, ['major', 'minor'])}"><i class="bi bi-${type === 'major' ? 'star' : 'circle'}"></i> ${escapeHtml(type)}</span>
          <span class="mandatory-badge ${mandatory ? 'yes' : 'no'}"><i class="bi bi-${mandatory ? 'exclamation-circle' : 'info-circle'}"></i> ${mandatory ? 'Mandatory' : 'Optional'}</span>
          ${recurring ? '<span class="recurring-badge"><i class="bi bi-arrow-repeat"></i> Every ' + escapeHtml(recurring.day) + '</span>' : ''}
        </div>
      </td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-secondary me-1" onclick="editEvent('${escapeHtml(event.id)}')">Edit</button>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteEvent('${escapeHtml(event.id)}')">Delete</button>
      </td>
    `;
    tbody.appendChild(row);
  });
}

// Bind add/edit event form handlers once (not inside loadEventsTable, which
// re-runs after every add/edit and would otherwise attach duplicate listeners
// that create duplicate events and announcements).
function bindEventFormHandlers() {
  const addForm = document.getElementById('addEventForm');
  if (addForm) {
    addForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      const name = document.getElementById('eventName').value.trim();
      const date = document.getElementById('eventDate').value;
      const time = document.getElementById('eventTime').value;
      const location = document.getElementById('eventLocation').value.trim();
      const type = document.getElementById('eventType').value;
      const mandatory = type === 'major';
      const attendanceType = document.getElementById('eventAttendanceType').value;
      const semesterEl = document.getElementById('eventSemester');
      const semester = semesterEl ? semesterEl.value : 'N/A';
      if (!name || !date || !time || !location) {
        showToast('error', 'Please fill all fields.');
        return;
      }
      const newEvent = {
        id: generateId('evt'),
        name,
        date,
        time,
        location,
        type,
        mandatory,
        attendanceType,
        semester
      };
      let savedEvent = null;
      if (isApiEnabled()) {
        try {
          savedEvent = await api.createEvent(newEvent);
          const events = getEvents();
          events.push(savedEvent);
          setEvents(events);
          setAnnouncements(await api.listAnnouncements());
        } catch (error) {
          showToast('error', error.message || 'Could not create event.');
          return;
        }
      } else {
        const events = getEvents();
        events.push(newEvent);
        setEvents(events);
      }
      if (!isApiEnabled()) {
        const announcements = getAnnouncements();
        announcements.unshift({
          id: generateId('notice'),
          title: `${name} has been announced`,
          detail: `${location} - ${date} at ${time}`,
          type: 'event'
        });
        setAnnouncements(announcements.slice(0, 10));
      }
      showToast(
        'success',
        'Event created successfully.'
      );
      addForm.reset();
      document.getElementById('addEventModal').querySelector('.btn-close').click();
      loadEventsTable();
    });
  }

  const editForm = document.getElementById('editEventForm');
  if (editForm) {
    editForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      const id = document.getElementById('editEventId').value;
      const name = document.getElementById('editEventName').value.trim();
      const date = document.getElementById('editEventDate').value;
      const time = document.getElementById('editEventTime').value;
      const location = document.getElementById('editEventLocation').value.trim();
      const type = document.getElementById('editEventType').value;
      const mandatory = type === 'major';
      const attendanceType = document.getElementById('editEventAttendanceType').value;
      const semesterEl = document.getElementById('editEventSemester');
      const semester = semesterEl ? semesterEl.value : 'N/A';
      if (!name || !date || !time || !location) {
        showToast('error', 'Please fill all fields.');
        return;
      }
      const events = getEvents();
      const idx = events.findIndex(e => sameId(e.id, id));
      if (idx === -1) {
        showToast('error', 'Event not found.');
        return;
      }
      const existing = events[idx];
      const updated = { ...existing, name, date, time, location, type, mandatory, attendanceType, semester };

      if (isApiEnabled()) {
        try {
          const endTime = existing.endTime && time < existing.endTime ? existing.endTime : undefined;
          const saved = await api.updateEvent(id, api.toEventPayload(updated, endTime));
          events[idx] = saved;
          setEvents(events);
          showToast(
            'success',
            'Event updated successfully.'
          );
          document.getElementById('editEventModal').querySelector('.btn-close').click();
          loadEventsTable();
        } catch (error) {
          showToast('error', error.message || 'Could not update event.');
        }
        return;
      }
      events[idx] = updated;
      setEvents(events);
      showToast('success', 'Event updated successfully.');
      document.getElementById('editEventModal').querySelector('.btn-close').click();
      loadEventsTable();
    });
  }
}

function removeEventFromLocalState(eventId) {
  const events = getEvents();
  setEvents(events.filter(e => !sameId(e.id, eventId)));
  setAttendance(getAttendance().filter(a => !sameId(a.eventId, eventId)));
}

async function deleteEvent(eventId) {
  if (!confirm('Are you sure you want to delete this event?')) return;
  const events = getEvents();
  const attendance = getAttendance();
  const target = events.find(e => sameId(e.id, eventId));
  const id = target ? target.id : eventId;
  const pending = syncEventDeleteToServer(id);

  // Treat the removal as optimistic in storage so a repeated lookup cannot
  // target the same row, but leave the table untouched until the server
  // answers; a refusal restores the snapshot below.
  removeEventFromLocalState(id);

  if (!pending) {
    showToast('success', 'Event deleted.');
    loadEventsTable();
    return;
  }

  try {
    await pending;
  } catch (error) {
    if (error.status === 404) {
      // The row is already gone on the server, so the local removal stands.
      showToast('info', 'Event was already deleted.');
      loadEventsTable();
      return;
    }
    // The server kept the row (most often 409 for attendance); put it back.
    setEvents(events);
    setAttendance(attendance);
    if (error.status === 409) {
      showToast('error', error.message || 'This event already has attendance records and cannot be deleted.');
    } else {
      showToast('error', error.message || 'Could not delete event.');
    }
    return;
  }

  // The server removed the event's announcement rows too. Re-pull the list
  // so this tab's cache cannot keep showing a deleted event.
  if (isApiEnabled()) {
    try {
      setAnnouncements(await api.listAnnouncements());
    } catch (ignored) {
      // A later hydration will repair the cache.
    }
  }

  showToast('success', 'Event deleted.');
  loadEventsTable();
}

/**
 * Push a newly created event to the backend and adopt the row the server
 * returns, so its id is the database id and later edits/deletes line up.
 *
 * Runs only in backend mode; a failure is reported but the local event is
 * left in place, because dropping it would lose what the officer typed.
 */
function syncEventToServer(event) {
  if (!isApiEnabled()) return;
  api.createEvent(event)
    .then((saved) => {
      const all = getEvents().map((e) => (sameId(e.id, event.id) ? Object.assign({}, e, saved) : e));
      setEvents(all);
      loadEventsTable();
    })
    .catch((err) => {
      showToast('error', 'Event saved locally only — the server rejected it: ' + err.message);
    });
}

/**
 * Delete an event server-side. Only numeric ids exist in the database.
 * Returns a promise when the API owns the row; local-only ids resolve
 * immediately so the caller can update localStorage.
 */
function syncEventDeleteToServer(eventId) {
  if (!isApiEnabled() || !/^\d+$/.test(String(eventId))) return;
  return api.deleteEvent(eventId);
}

function editEvent(eventId) {
  const events = getEvents();
  const event = events.find(e => sameId(e.id, eventId));
  if (!event) return;
  document.getElementById('editEventId').value = event.id;
  document.getElementById('editEventName').value = event.name;
  document.getElementById('editEventDate').value = event.date;
  document.getElementById('editEventTime').value = event.time;
  document.getElementById('editEventLocation').value = event.location;
  document.getElementById('editEventType').value = event.type || 'minor';
  const semesterEl = document.getElementById('editEventSemester');
  if (semesterEl) semesterEl.value = event.semester || 'N/A';
  const modal = new bootstrap.Modal(document.getElementById('editEventModal'));
  modal.show();
}


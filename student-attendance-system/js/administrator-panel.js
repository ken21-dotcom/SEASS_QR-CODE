/* ============================================================
   Administrator Panel — all admin page logic
   ============================================================ */

document.addEventListener('DOMContentLoaded', async function () {
  var user = await requireServerAuth('admin');
  if (!user) return;

  /* ── User dropdown toggle ── */
  var userToggle = document.getElementById('userDropdownToggle');
  var userMenu   = document.getElementById('userDropdownMenu');
  if (userToggle && userMenu) {
    userToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = userMenu.classList.toggle('open');
      userToggle.setAttribute('aria-expanded', open);
    });
    document.addEventListener('click', function () {
      userMenu.classList.remove('open');
      userToggle.setAttribute('aria-expanded', 'false');
    });
  }

  if (document.getElementById('adminEmail') && user.email) {
    document.getElementById('adminEmail').textContent = user.email;
  }

  /* ── Route to page-specific init ── */
  if (document.getElementById('statTotalStudents'))     initAdminDashboard();
  if (document.getElementById('officerTableBody'))     initAdminManageOfficers();
  if (document.getElementById('studentTableBody'))     initAdminManageStudents();
  if (document.getElementById('reportEvent')) {
    if (document.getElementById('attendanceCorrectionsBody')) initAttendanceCorrectionReview();
    if (window.ReportsPage) await window.ReportsPage.init();
  }
  if (document.getElementById('eventTableBody')) initAdminManageEvents();
  if (document.getElementById('semesterName'))         initAdminSettings();
});


/* ============================================================
   Admin Dashboard
   ============================================================ */

function initAdminDashboard() {
  // Dashboard stats are rendered by the inline script in admin-dashboard.html.
  // The data is sourced from getEvents(), getAttendance(), and getUsers()
  // which read from localStorage - hydrated from the API on login via hydrateFromApi().
  //
  // Backend data shapes:
  // - GET /users returns: id, role, status, name, email, etc.
  // - GET /events returns: id, publicId, name, date, time, location, status, etc.
  // - GET /attendance returns: id, eventId, studentId, date, time, status (present/late), etc.
  // - GET /audit-logs returns: id, userId, actorName, actorEmail, actorRole,
  //   targetName, targetEmail, targetRole, action, tableName, recordId, createdAt, etc.
  //
  // The hydration happens automatically after successful login in api.js.
}


/* ============================================================
   Recent System Activity — audit log presentation
   ============================================================ */

/**
 * Readable actor label for one audit-log row.
 *
 * The seeded administrator is stored as "System Administrator", which is
 * a placeholder rather than a person's name, so that value falls back to
 * the actor email. A real admin name is prefixed with "Admin".
 *
 * @param {Object} log
 * @returns {string}
 */
function auditLogActorLabel(log) {
  var name = String(log.actorName || '').trim();
  var email = String(log.actorEmail || '').trim();

  if (name && !/^system administrator$/i.test(name)) {
    return log.actorRole === 'administrator' && !/^admin\b/i.test(name)
      ? 'Admin ' + name
      : name;
  }

  return email || 'System';
}

/**
 * Target's name from the joined users/students row, falling back to the
 * values captured in the audit payload.
 *
 * @param {Object} log
 * @returns {string}
 */
function auditLogTargetName(log) {
  var name = String(log.targetName || '').trim();
  if (name) return name;

  var values = log.newValues || log.oldValues || {};
  name = String(values.name || values.displayName || '').trim();
  if (name) return name;

  return String(log.targetEmail || '').trim();
}

/** Event name captured in the audit payload, with a caller fallback. */
function auditLogEventName(log, fallback) {
  var values = log.newValues || log.oldValues || {};
  return String(values.name || '').trim() || fallback;
}

/** Friendly label for an account role. */
function auditRoleLabel(role) {
  var normalized = String(role || '').toLowerCase();
  if (normalized === 'student') return 'student';
  if (normalized === 'ssc-officer' || normalized === 'ssc_officer' || normalized === 'officer') return 'officer';
  if (normalized === 'administrator' || normalized === 'admin') return 'administrator';
  return 'user';
}

/** "a student" / "an officer" / "a user" (u sounds like "yoo"). */
function auditArticle(word) {
  if (/^user$/i.test(word)) return 'a ';
  return /^[aeiou]/i.test(word) ? 'an ' : 'a ';
}

/**
 * Convert one audit-log row into the icon and sentence shown in the
 * dashboard's Recent System Activity feed.
 *
 * @param {Object} log
 * @returns {{icon: string, text: string}}
 */
function auditLogActivity(log) {
  var actor = escapeHtml(auditLogActorLabel(log));
  var table = String(log.tableName || '').trim();
  var targetName = auditLogTargetName(log);
  var target = targetName
    ? escapeHtml(targetName)
    : escapeHtml('user #' + log.recordId);
  var role = auditRoleLabel(
    log.targetRole ||
    (log.newValues && log.newValues.role) ||
    (log.oldValues && log.oldValues.role)
  );
  var rolePhrase = auditArticle(role) + role;
  var icon = 'bi-arrow-right-circle';
  var text;

  switch (log.action) {
    case 'create':
      if (table === 'users') {
        text = actor + ' created ' + rolePhrase + (targetName ? ' ' + target : '');
        icon = 'bi-person-plus';
      } else if (table === 'events') {
        text = actor + ' created event ' + escapeHtml(auditLogEventName(log, 'New Event'));
        icon = 'bi-calendar-plus';
      } else {
        text = actor + ' created ' + escapeHtml(table || 'a record');
        icon = 'bi-plus-circle';
      }
      break;

    case 'update':
      if (table === 'users') {
        var oldStatus = log.oldValues && log.oldValues.status;
        var newStatus = log.newValues && log.newValues.status;
        if (oldStatus && newStatus && oldStatus !== newStatus) {
          text = actor + ' changed ' +
            (newStatus === 'active' ? 'activation' : 'deactivation') +
            ' for ' + target;
        } else {
          text = actor + ' updated ' + rolePhrase + ' ' + target;
        }
        icon = 'bi-person-check';
      } else if (table === 'events') {
        text = actor + ' updated event ' + escapeHtml(auditLogEventName(log, '#' + log.recordId));
        icon = 'bi-pencil';
      } else {
        text = actor + ' updated ' + escapeHtml(table || 'a record') + ' #' + escapeHtml(String(log.recordId));
        icon = 'bi-pencil';
      }
      break;

    case 'delete':
      if (table === 'users') {
        text = actor + ' deleted ' + rolePhrase + ' ' + target;
        icon = 'bi-trash';
      } else if (table === 'events') {
        text = actor + ' deleted event ' + escapeHtml(auditLogEventName(log, '#' + log.recordId));
        icon = 'bi-trash';
      } else {
        text = actor + ' deleted ' + escapeHtml(table || 'a record') + ' #' + escapeHtml(String(log.recordId));
        icon = 'bi-trash';
      }
      break;

    default:
      text = actor + ' performed ' + escapeHtml(String(log.action || 'an action')) + ' on ' + escapeHtml(table || 'a record');
  }

  return { icon: icon, text: text };
}


/* ============================================================
   Admin — Manage Officers
   ============================================================ */

function mergeCachedUsers(updates) {
  if (!updates || !updates.length) return;
  var users = getUsers();
  updates.forEach(function (updated) {
    if (!updated || updated.id === undefined) return;
    var idx = users.findIndex(function (u) { return sameId(u.id, updated.id); });
    if (idx === -1) {
      users.push(updated);
    } else {
      users[idx] = Object.assign({}, users[idx], updated);
    }
  });
  setUsers(users);
}

function mergeCachedUser(updated) {
  mergeCachedUsers([updated]);
}

function normalizedAccountStatus(status) {
  return status === 'deactivated' ? 'inactive' : (status || 'active');
}

function accountStatusBadge(status) {
  status = normalizedAccountStatus(status);
  if (status === 'pending') return '<span class="badge bg-warning text-dark">Pending</span>';
  if (status === 'inactive') return '<span class="badge bg-secondary">Deactivated</span>';
  return '<span class="badge bg-success">Active</span>';
}

function accountErrorMessage(error, fallback) {
  return error && error.message ? error.message : fallback;
}

function initAdminManageOfficers() {
  loadOfficersTable();
  refreshOfficersFromApi();

  var addForm = document.getElementById('addOfficerForm');
  if (addForm) {
    addForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var firstName = document.getElementById('officerFirstName').value.trim();
      var lastName  = document.getElementById('officerLastName').value.trim();
      var email     = document.getElementById('officerEmail').value.trim();
      var position  = document.getElementById('officerPosition').value.trim();
      var password  = document.getElementById('officerPassword').value;
      var requiredFields = [
        ['officerFirstName', firstName, 'Please enter the officer\'s first name.'],
        ['officerLastName', lastName, 'Please enter the officer\'s last name.'],
        ['officerEmail', email, 'Please enter a valid email address.'],
        ['officerPosition', position, 'Please enter the officer\'s position.'],
        ['officerPassword', password, 'Temporary password must be at least 8 characters.']
      ];
      var firstInvalid = null;
      requiredFields.forEach(function (entry) {
        var field = document.getElementById(entry[0]);
        var valid = entry[1].length > 0 && (entry[0] !== 'officerPassword' || entry[1].length >= 8);
        if (!valid) {
          if (typeof setInlineFieldError === 'function') setInlineFieldError(field, entry[2]);
          firstInvalid = firstInvalid || field;
        }
      });
      if (firstInvalid) { firstInvalid.focus(); return; }
      var submit = addForm.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      api.createOfficer({
        firstName: firstName,
        lastName: lastName,
        email: email,
        position: position,
        password: password,
      }).then(function (officer) {
        mergeCachedUser(officer);
        addForm.reset();
        var modal = bootstrap.Modal.getInstance(document.getElementById('addOfficerModal'));
        if (modal) modal.hide();
        showToast('success', 'Officer created. They must change the temporary password at first sign-in.');
        loadOfficersTable();
      }).catch(function (error) {
        showToast('error', accountErrorMessage(error, 'Could not create the officer.'));
      }).then(function () {
        if (submit) submit.disabled = false;
      });
    });
  }
}

function refreshOfficersFromApi() {
  api.listUsers(null, 'ssc-officer').then(function (officers) {
    mergeCachedUsers(officers);
    loadOfficersTable();
  }).catch(function (error) {
    showToast('error', accountErrorMessage(error, 'Could not refresh officers.'));
  });
}

function loadOfficersTable() {
  var officers = getUsers().filter(function (u) { return u.role === 'ssc-officer'; });
  var tbody = document.getElementById('officerTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!officers.length) {
    tbody.innerHTML = emptyTableRow(5, 'No officer accounts yet', 'Create an officer account to get started.', 'bi-person-badge');
    return;
  }
  officers.forEach(function (officer) {
    var status = normalizedAccountStatus(officer.status);
    var row = document.createElement('tr');
    row.innerHTML =
      '<td>' + escapeHtml(officer.name) + '</td>' +
      '<td>' + escapeHtml(officer.email) + '</td>' +
      '<td>' + escapeHtml(officer.position || officer.org || '—') + '</td>' +
      '<td>' + accountStatusBadge(status) + '</td>' +
      '<td>' +
        (status === 'pending'
          ? '<button class="btn btn-sm btn-success me-1" onclick="approveOfficer(\'' + escapeHtml(officer.id) + '\')"><i class="bi bi-check-lg"></i> Approve</button>'
          : '') +
        (status === 'active'
          ? '<button class="btn btn-sm btn-outline-warning" onclick="deactivateOfficer(\'' + escapeHtml(officer.id) + '\')"><i class="bi bi-pause"></i> Deactivate</button>'
          : '') +
        (status === 'inactive'
          ? '<button class="btn btn-sm btn-outline-success" onclick="reactivateOfficer(\'' + escapeHtml(officer.id) + '\')"><i class="bi bi-play"></i> Reactivate</button>'
          : '') +
      '</td>';
    tbody.appendChild(row);
  });
}

function changeOfficerStatus(id, status, successMessage) {
  api.updateUserStatus(id, status).then(function (officer) {
    mergeCachedUser(officer);
    showToast('success', successMessage);
    loadOfficersTable();
  }).catch(function (error) {
    showToast('error', accountErrorMessage(error, 'Could not update the officer.'));
  });
}

function approveOfficer(id) {
  changeOfficerStatus(id, 'active', 'Officer approved.');
}

function deactivateOfficer(id) {
  if (!confirm('Deactivate this officer? They will be unable to log in.')) return;
  changeOfficerStatus(id, 'inactive', 'Officer deactivated.');
}

function reactivateOfficer(id) {
  changeOfficerStatus(id, 'active', 'Officer reactivated.');
}


/* ============================================================
   Admin — Manage Students
   ============================================================ */

var pendingRegistrationsRequest = 0;
var studentStatusBusy = false;

function initAdminManageStudents() {
  // Grouped by Department → Course → Year Level, with filters + search.
  initGroupedStudentList({
    tbodyId: 'studentTableBody',
    countId: 'studentCount',
    departmentFilterId: 'filterDepartment',
    courseFilterId: 'filterCourse',
    yearFilterId: 'filterYear',
    searchId: 'studentSearch',
    colspan: 7,
    filter: function (student) {
      return normalizedAccountStatus(student.status) !== 'pending';
    },
    renderRow: function (student) {
      var status = normalizedAccountStatus(student.status);
      return '<td>' + escapeHtml(student.name) + '</td>' +
        '<td>' + escapeHtml(student.studentIdNumber || '—') + '</td>' +
        '<td>' + escapeHtml(student.email) + '</td>' +
        '<td>' + yearBadge(student) + '</td>' +
        '<td>' + escapeHtml(student.block || '—') + '</td>' +
        '<td>' + accountStatusBadge(status) + '</td>' +
        '<td>' +
          '<button class="btn btn-sm btn-outline-secondary me-1" onclick="editStudent(\'' + escapeHtml(student.id) + '\')"><i class="bi bi-pencil"></i> Edit</button>' +
          (status === 'active'
            ? '<button class="btn btn-sm btn-outline-warning" onclick="deactivateStudent(\'' + escapeHtml(student.id) + '\')"><i class="bi bi-pause"></i> Deactivate</button>'
            : '<button class="btn btn-sm btn-outline-success" onclick="reactivateStudent(\'' + escapeHtml(student.id) + '\')"><i class="bi bi-play"></i> Reactivate</button>') +
        '</td>';
    },
  });

  var refreshPending = document.getElementById('refreshPendingRegistrations');
  if (refreshPending) {
    refreshPending.addEventListener('click', loadPendingRegistrations);
  }
  loadPendingRegistrations();
}

function loadPendingRegistrations() {
  var tbody = document.getElementById('pendingRegistrationsBody');
  if (!tbody) return;
  var countEl = document.getElementById('pendingRegistrationsCount');
  var refreshBtn = document.getElementById('refreshPendingRegistrations');
  var requestId = ++pendingRegistrationsRequest;

  tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Loading pending registrations…</td></tr>';
  if (refreshBtn) refreshBtn.disabled = true;

  api.listUsers('pending', 'student').then(function (students) {
    if (requestId !== pendingRegistrationsRequest) return;
    mergeCachedUsers(students);
    if (countEl) countEl.textContent = students.length;
    if (!students.length) {
      tbody.innerHTML = emptyTableRow(5, 'No pending registrations', 'New student sign-ups will appear here.', 'bi-person-check');
      return;
    }
    tbody.innerHTML = students.map(function (student) {
      var detail = [student.program, student.yearLevel ? getStudentYearLabel(student.yearLevel) : '']
        .filter(function (part) { return !!part; }).join(' · ');
      return '<tr>' +
        '<td>' + escapeHtml(student.name) + '</td>' +
        '<td>' + escapeHtml(student.studentIdNumber || '—') + '</td>' +
        '<td>' + escapeHtml(student.email) + '</td>' +
        '<td>' + escapeHtml(detail || '—') + '</td>' +
        '<td>' +
          '<button class="btn btn-sm btn-success me-1" onclick="approvePendingStudent(\'' + escapeHtml(student.id) + '\')"><i class="bi bi-check-lg"></i> Approve</button>' +
          '<button class="btn btn-sm btn-outline-danger" onclick="rejectPendingStudent(\'' + escapeHtml(student.id) + '\')"><i class="bi bi-x-lg"></i> Reject</button>' +
        '</td>' +
        '</tr>';
    }).join('');
  }).catch(function (error) {
    if (requestId !== pendingRegistrationsRequest) return;
    if (countEl) countEl.textContent = '—';
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger py-4">' +
      escapeHtml(accountErrorMessage(error, 'Could not load pending registrations.')) + '</td></tr>';
  }).then(function () {
    if (requestId === pendingRegistrationsRequest && refreshBtn) refreshBtn.disabled = false;
  });
}

function approvePendingStudent(id) {
  changeStudentStatus(id, 'active', 'Student registration approved.');
}

function rejectPendingStudent(id) {
  if (!confirm('Reject this registration? The student account will be deactivated.')) return;
  changeStudentStatus(id, 'inactive', 'Student registration rejected.');
}

function changeStudentStatus(id, status, successMessage) {
  if (studentStatusBusy) return;
  studentStatusBusy = true;
  api.updateUserStatus(id, status).then(function (student) {
    mergeCachedUser(student);
    showToast('success', successMessage);
    refreshGroupedStudentList();
    loadPendingRegistrations();
  }).catch(function (error) {
    showToast('error', accountErrorMessage(error, 'Could not update the student.'));
  }).then(function () {
    studentStatusBusy = false;
  });
}

function deactivateStudent(id) {
  if (!confirm('Deactivate this student? They will be unable to log in.')) return;
  changeStudentStatus(id, 'inactive', 'Student deactivated.');
}

function reactivateStudent(id) {
  changeStudentStatus(id, 'active', 'Student reactivated.');
}

function editStudent(id) {
  var users = getUsers();
  var student = users.find(function (u) { return sameId(u.id, id); });
  if (!student) return;
  document.getElementById('editStudentId').value    = student.id;
  document.getElementById('editStudentName').value  = student.name;
  document.getElementById('editStudentEmail').value = student.email;
  // Org selects (department → course cascade) for the current student.
  var org = normalizeStudentOrg(student);
  initOrgModalSelects('editStudentDepartment', 'editStudentCourse', 'editStudentYear', {
    department: org.department,
    course: org.course,
    yearLevel: org.yearLevel,
  });
  var modal = new bootstrap.Modal(document.getElementById('editStudentModal'));
  modal.show();
}

async function confirmEditStudent() {
  var id    = document.getElementById('editStudentId').value;
  var name  = document.getElementById('editStudentName').value.trim();
  var email = document.getElementById('editStudentEmail').value.trim();
  if (!name || !email) { showToast('error', 'Please fill all fields.'); return; }
  var users = getUsers();
  var idx = users.findIndex(function (u) { return sameId(u.id, id); });
  if (idx === -1) return;
  var department = (document.getElementById('editStudentDepartment') || {}).value || '';
  var program = (document.getElementById('editStudentCourse') || {}).value || '';
  var yearLevel = (document.getElementById('editStudentYear') || {}).value || '';
  var org = normalizeStudentOrg({ department: department, program: program });
  if (org.department !== UNASSIGNED) department = org.department;
  if (org.course !== UNASSIGNED) program = org.course;
  if (isApiEnabled() && Number.isInteger(users[idx].id)) {
    try {
      users[idx] = await api.updateStudentProfile(users[idx].id, {
        name: name, email: email, department: department, program: program, yearLevel: yearLevel,
      });
    } catch (error) {
      showToast('error', error.message || 'Student profile could not be saved.');
      return;
    }
  } else {
    users[idx].name = name;
    users[idx].email = email;
    users[idx].department = department;
    users[idx].program = program;
    users[idx].course = program;
    users[idx].yearLevel = yearLevel;
  }
  setUsers(users);
  document.getElementById('editStudentModal').querySelector('.btn-close').click();
  showToast('success', 'Student updated.');
  refreshGroupedStudentList();
}



/* ============================================================
   Admin — Reports
   ============================================================ */

function initAttendanceCorrectionReview() {
  var tbody = document.getElementById('attendanceCorrectionsBody');
  if (!tbody) return;
  var proofRequests = {};

  function showProof(id) {
    var request = proofRequests[id];
    if (!request) {
      showToast('error', 'This request is no longer available.');
      return;
    }
    openAttendanceProof(id, request.studentName + ' · ' + request.eventName + ' · ' + formatDate(request.eventDate));
  }

  var denyModalEl = document.getElementById('denyRequestModal');
  var denyInput = document.getElementById('denyReasonInput');
  var denyError = document.getElementById('denyReasonError');
  var denyConfirm = document.getElementById('denyRequestConfirm');
  var pendingDenyId = null;

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
    var modal = denyModalInstance();
    if (modal) modal.show();
  }

  if (denyInput) {
    denyInput.addEventListener('input', function () {
      denyInput.classList.remove('is-invalid');
      if (denyError) denyError.textContent = '';
    });
  }

  if (denyModalEl) {
    denyModalEl.addEventListener('shown.bs.modal', function () {
      if (denyInput) denyInput.focus();
    });
    denyModalEl.addEventListener('hidden.bs.modal', resetDenyForm);
  }

  if (denyConfirm) {
    denyConfirm.addEventListener('click', async function () {
      var notes = denyInput ? denyInput.value.trim() : '';
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
        var modal = denyModalInstance();
        if (modal) modal.hide();
        showToast('success', 'Correction request denied.');
        await render();
        if (typeof hydrateFromApi === 'function') await hydrateFromApi();
      } catch (error) {
        denyFailure(error.message || 'Request could not be reviewed.');
      }
    });
  }

  async function render() {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted">Loading requests…</td></tr>';
    try {
      var rows = await api.listAttendanceCorrections();
      proofRequests = {};
      tbody.innerHTML = rows.length ? rows.map(function (request) {
        proofRequests[request.id] = request;
        var actions = request.status === 'pending'
          ? '<div class="table-actions"><button class="btn btn-sm btn-success" type="button" data-correction-decision="approved" data-id="' + request.id + '"><i class="bi bi-check-lg" aria-hidden="true"></i> Approve &amp; apply</button><button class="btn btn-sm btn-outline-danger" type="button" data-correction-decision="denied" data-id="' + request.id + '"><i class="bi bi-x-lg" aria-hidden="true"></i> Deny</button></div>'
          : '<span class="text-muted">' + escapeHtml(request.reviewNotes || 'Reviewed') + '</span>';
        var proof = request.hasProof
          ? '<button class="btn btn-sm btn-outline-secondary correction-proof-btn" type="button" data-proof-id="' + request.id + '"><i class="bi bi-image" aria-hidden="true"></i> View proof</button>'
          : '<span class="correction-proof-missing"><i class="bi bi-image" aria-hidden="true"></i> No proof</span>';
        return '<tr><td>' + escapeHtml(request.studentName) + '<small class="d-block text-muted">' + escapeHtml(request.studentIdNumber) + '</small></td><td>' + escapeHtml(request.eventName) + '<small class="d-block text-muted">' + escapeHtml(formatDate(request.eventDate)) + '</small></td><td>' + escapeHtml(String(request.requestedCheckInTime || '').replace('T', ' ').slice(0, 16)) + '<small class="d-block text-muted">Current: ' + escapeHtml(request.currentCheckInTime ? String(request.currentCheckInTime).slice(0, 16) : 'No record') + '</small></td><td>' + escapeHtml(request.reason) + '</td><td>' + proof + '</td><td><span class="badge bg-' + (request.status === 'approved' ? 'success' : request.status === 'denied' ? 'danger' : 'secondary') + '">' + escapeHtml(request.status) + '</span></td><td>' + actions + '</td></tr>';
      }).join('') : emptyTableRow(7, 'No correction requests', 'Student requests will appear here.', 'bi-clock-history');
    } catch (error) { tbody.innerHTML = '<tr><td colspan="7" class="text-danger">' + escapeHtml(error.message || 'Could not load requests.') + '</td></tr>'; }
  }
  tbody.addEventListener('click', async function (event) {
    var proofButton = event.target.closest('[data-proof-id]');
    if (proofButton) {
      showProof(proofButton.dataset.proofId);
      return;
    }
    var button = event.target.closest('[data-correction-decision]');
    if (!button) return;
    var decision = button.dataset.correctionDecision;
    if (decision === 'denied') {
      openDenyModal(button.dataset.id);
      return;
    }
    button.disabled = true;
    try {
      await api.reviewAttendanceCorrection(button.dataset.id, decision, '');
      showToast('success', 'Attendance updated from the reviewed request.');
      await render();
      if (typeof hydrateFromApi === 'function') await hydrateFromApi();
    } catch (error) { showToast('error', error.message || 'Request could not be reviewed.'); button.disabled = false; }
  });
  render();
}

/* ============================================================
   Admin — Manage Events
   ============================================================ */

function initAdminManageEvents() {
  loadEventsTable();
}

function loadEventsTable() {
  var tbody = document.getElementById('eventTableBody');
  var empty = document.getElementById('eventsTableEmpty');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Loading events...</td></tr>';

  var events = getEvents();
  if (!events || !events.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  tbody.innerHTML = events.map(function (ev) {
    var typeLabel = ev.type === 'major' ? 'Major' : 'Minor';
    var mandatoryLabel = ev.mandatory ? 'Mandatory' : 'Optional';
    var attendanceLabel = '1 Scan';
    if (ev.attendanceType === 'in_out') attendanceLabel = '2 Scans';
    else if (ev.attendanceType === 'four_point') attendanceLabel = '4 Scans';

    return '<tr>' +
      '<td><strong>' + escapeHtml(ev.name) + '</strong></td>' +
      '<td>' + formatDate(ev.date) + '</td>' +
      '<td>' + (ev.time || '--:--') + '</td>' +
      '<td>' + escapeHtml(ev.location || 'TBA') + '</td>' +
      '<td>' +
        '<div class="event-badges">' +
          '<span class="event-type-badge ' + ev.type + '">' + typeLabel + '</span>' +
          '<span class="mandatory-badge ' + (ev.mandatory ? 'yes' : 'no') + '">' + mandatoryLabel + '</span>' +
          '<span class="badge bg-' + (ev.attendanceType === 'single' ? 'info' : ev.attendanceType === 'in_out' ? 'warning' : 'primary') + '">' + attendanceLabel + '</span>' +
        '</div>' +
      '</td>' +
      '<td class="text-end">' +
        '<button class="btn btn-sm btn-outline-secondary me-1" onclick="editEvent(' + ev.id + ')"><i class="bi bi-pencil"></i> Edit</button>' +
        '<button class="btn btn-sm btn-outline-danger" onclick="deleteEvent(' + ev.id + ')"><i class="bi bi-trash"></i> Delete</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function formatDate(dateStr) {
  if (!dateStr) return '--';
  var d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sameId(a, b) {
  return String(a) === String(b);
}function generateId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
}

// ── Event CRUD (shared with ssc.js; duplicated here for admin page) ──

var addForm = document.getElementById('addEventForm');
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
    if (isApiEnabled()) {
      try {
        const savedEvent = await api.createEvent(newEvent);
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
    showToast('success', 'Event created successfully.');
    addForm.reset();
    document.getElementById('addEventModal').querySelector('.btn-close').click();
    loadEventsTable();
  });
}

var editForm = document.getElementById('editEventForm');
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
        showToast('success', 'Event updated successfully.');
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

// Expose event functions globally for inline onclick handlers
window.editEvent = function(eventId) {
  const events = getEvents();
  const event = events.find(e => sameId(e.id, eventId));
  if (!event) return;
  document.getElementById('editEventId').value = event.id;
  document.getElementById('editEventName').value = event.name;
  document.getElementById('editEventDate').value = event.date;
  document.getElementById('editEventTime').value = event.time;
  document.getElementById('editEventLocation').value = event.location;
  document.getElementById('editEventType').value = event.type || 'minor';
  document.getElementById('editEventAttendanceType').value = event.attendanceType || 'single';
  const semesterEl = document.getElementById('editEventSemester');
  if (semesterEl) semesterEl.value = event.semester || 'N/A';
  const modal = new bootstrap.Modal(document.getElementById('editEventModal'));
  modal.show();
};

window.deleteEvent = function(eventId) {
  if (!confirm('Are you sure you want to delete this event?')) return;
  const events = getEvents();
  const attendance = getAttendance();
  const target = events.find(e => sameId(e.id, eventId));
  const id = target ? target.id : eventId;

  if (isApiEnabled()) {
    api.deleteEvent(id)
      .then(() => {
        setEvents(events.filter(e => !sameId(e.id, id)));
        setAttendance(attendance.filter(a => !sameId(a.eventId, id)));
        showToast('success', 'Event deleted.');
        loadEventsTable();
      })
      .catch((err) => {
        showToast('error', err.message || 'Could not delete event.');
      });
  } else {
    setEvents(events.filter(e => !sameId(e.id, id)));
    setAttendance(attendance.filter(a => !sameId(a.eventId, id)));
    showToast('success', 'Event deleted.');
    loadEventsTable();
  }
};

/* ============================================================
   Admin — Settings
   ============================================================ */

function initAdminSettings() {
  var semester = safeGet('attendly_semester', { name: 'SY 2026–2027', term: '1st Semester', startDate: '', endDate: '' });
  document.getElementById('semesterName').value      = semester.name;
  document.getElementById('semesterTerm').value      = semester.term;
  document.getElementById('semesterStart').value     = semester.startDate;
  document.getElementById('semesterEnd').value       = semester.endDate;

  document.getElementById('saveSemesterBtn').addEventListener('click', function () {
    var newSem = {
      name:      document.getElementById('semesterName').value.trim(),
      term:      document.getElementById('semesterTerm').value.trim(),
      startDate: document.getElementById('semesterStart').value,
      endDate:   document.getElementById('semesterEnd').value
    };
    localStorage.setItem('attendly_semester', JSON.stringify(newSem));
    showToast('success', 'Semester settings saved.');
  });

  loadKioskStations();
  window.setInterval(loadKioskStations, 60000);
  var stationForm = document.getElementById('addStationForm');
  if (stationForm) {
    stationForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var name   = document.getElementById('stationName').value.trim();
      var device = document.getElementById('stationDevice').value.trim();
      var loc    = document.getElementById('stationLocation').value.trim();
      if (!name) { showToast('error', 'Station name is required.'); return; }
      var button = stationForm.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        await api.createStation({ name: name, device: device || null, location: loc || null });
        await loadKioskStations();
        stationForm.reset();
        showToast('success', 'Kiosk station added and shared.');
      } catch (error) { showToast('error', error.message || 'Station could not be added.'); }
      finally { button.disabled = false; }
    });
  }
}

async function loadKioskStations() {
  var tbody = document.getElementById('stationTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Loading stations…</td></tr>';
  var stations;
  try { stations = await api.listStations(); }
  catch (error) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger py-4">' + escapeHtml(error.message || 'Could not load stations.') + '</td></tr>';
    return;
  }
  if (!stations.length) {
    tbody.innerHTML = emptyTableRow(6, 'No kiosk stations', 'Register a station to start tracking check-ins.', 'bi-display');
    return;
  }
  tbody.innerHTML = stations.map(function (st) {
    var health = st.status === 'online'
      ? '<span class="badge bg-success">Online</span><small class="d-block text-muted">' + escapeHtml(st.lastSeenAt) + '</small>'
      : '<span class="badge bg-secondary">Offline</span><small class="d-block text-muted">' + escapeHtml(st.lastSeenAt ? 'Last seen ' + st.lastSeenAt : 'Never connected') + '</small>';
    return '<tr><td>' + escapeHtml(st.name) + '</td><td>' + escapeHtml(st.device || '—') + '</td><td>' + escapeHtml(st.location || '—') + '</td><td>' + health + '</td><td><code>' + escapeHtml(st.id) + '</code> <button class="btn btn-sm btn-outline-secondary" type="button" onclick="copyStationUrl(' + Number(st.id) + ')" aria-label="Copy kiosk URL for ' + escapeHtml(st.name) + '"><i class="bi bi-clipboard" aria-hidden="true"></i></button></td><td><button class="btn btn-sm btn-outline-danger" type="button" onclick="deleteStation(' + Number(st.id) + ')" aria-label="Remove ' + escapeHtml(st.name) + '"><i class="bi bi-trash" aria-hidden="true"></i></button></td></tr>';
  }).join('');
}

async function copyStationUrl(id) {
  var url = new URL('../kiosk.html?station=' + encodeURIComponent(id), window.location.href).href;
  try {
    await navigator.clipboard.writeText(url);
    showToast('success', 'Kiosk URL copied.');
  } catch (error) {
    window.prompt('Copy this kiosk URL:', url);
  }
}

async function deleteStation(id) {
  if (!confirm('Remove this kiosk station?')) return;
  try {
    await api.deleteStation(id);
    await loadKioskStations();
    showToast('success', 'Station removed.');
  } catch (error) { showToast('error', error.message || 'Station could not be removed.'); }
}

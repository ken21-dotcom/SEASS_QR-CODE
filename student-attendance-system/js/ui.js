/* ============================================================
   UI Utilities — toast notifications, theme, formatting, badges
   ------------------------------------------------------------
   Shared across all pages. Provides toast popups, dark/light
   theme toggling, date formatting, severity badges, and
   empty-state helpers. The escapeHtml function is critical
   for XSS prevention — always use it before injecting user
   data into innerHTML.
   ============================================================ */

/**
 * Escape HTML special characters to prevent XSS when
 * injecting user-supplied strings into innerHTML.
 *
 * @param {*} str — value to escape (coerced to string)
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, ch => escapeMap[ch]);
}

/**
 * Reduce a value to a safe CSS class token.
 *
 * HTML-escaping alone is not the right tool for a class attribute. The
 * escaping stops a value from closing the attribute, but it still lets
 * arbitrary *tokens* through, so a record could inject styling classes
 * it has no business owning (layout overrides, display:none, and so on).
 * This position allowlists the exact tokens it accepts and falls back to
 * a neutral one otherwise.
 *
 * @param {*} value
 * @param {string[]} allowed - exact tokens permitted for this position
 * @returns {string}
 */
function safeToken(value, allowed) {
  return allowed.includes(value) ? value : 'unknown';
}

function setInlineFieldError(field, message) {
  if (!field) return;
  field.classList.add('is-invalid');
  field.setAttribute('aria-invalid', 'true');
  var inputGroup = field.closest('.input-group');
  var feedbackHost = inputGroup ? inputGroup.parentElement : field.parentElement;
  var feedback = feedbackHost && feedbackHost.querySelector(':scope > .invalid-feedback');
  if (!feedback && field.nextElementSibling && field.nextElementSibling.classList.contains('invalid-feedback')) {
    feedback = field.nextElementSibling;
  }
  if (!feedback && feedbackHost && feedbackHost.parentElement) {
    feedback = feedbackHost.parentElement.querySelector(':scope > .invalid-feedback');
  }
  if (!feedback) return;
  feedback.textContent = message;
  feedback.style.display = 'block';
}

function clearInlineFieldError(field) {
  if (!field) return;
  field.classList.remove('is-invalid');
  field.removeAttribute('aria-invalid');
  var inputGroup = field.closest('.input-group');
  var feedbackHost = inputGroup ? inputGroup.parentElement : field.parentElement;
  var feedback = feedbackHost && feedbackHost.querySelector(':scope > .invalid-feedback');
  if (!feedback && feedbackHost && feedbackHost.parentElement) {
    feedback = feedbackHost.parentElement.querySelector(':scope > .invalid-feedback');
  }
  if (feedback) feedback.style.display = '';
}

if (typeof document !== 'undefined') {
  document.addEventListener('input', function (event) {
    if (event.target && event.target.matches('input, textarea, select')) {
      clearInlineFieldError(event.target);
    }
  });
  document.addEventListener('change', function (event) {
    if (event.target && event.target.matches('input, textarea, select')) {
      clearInlineFieldError(event.target);
    }
  });
}

/**
 * Display a toast notification. Falls back to a plain DOM
 * element when Bootstrap's JS is unavailable.
 *
 * @param {'success'|'error'|'info'|'warning'} type
 * @param {string} message — plain text (not HTML)
 */
function showToast(type, message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const variantClass = type === 'success' ? 'toast-success'
                     : type === 'error'   ? 'toast-error'
                     : 'toast-info';

  const toastEl = document.createElement('div');
  toastEl.className = `toast align-items-center border-0 ${variantClass}`;
  toastEl.setAttribute('role', 'alert');
  toastEl.style.marginBottom = '0.5rem';
  toastEl.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${escapeHtml(message)}</div>
      <button type="button" class="btn-close me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>
  `;
  container.appendChild(toastEl);
  if (window.bootstrap && window.bootstrap.Toast) {
    const toast = new window.bootstrap.Toast(toastEl, { delay: 3000 });
    toast.show();
    toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
    return;
  }

  // Keep feedback working when the optional Bootstrap CDN is unavailable.
  toastEl.style.cssText += 'display:block;padding:0.75rem 1rem;border-radius:0.375rem;';
  window.setTimeout(() => toastEl.remove(), 3000);
}

/* ============================================================
   Attendance proof viewer
   ------------------------------------------------------------
   The corrections list only carries hasProof, so the photo is fetched
   from /attendance-corrections/:id/proof when the viewer is opened.
   Shared by the student page and both staff report tables.
   ============================================================ */

/**
 * Open the shared proof modal and load one request's image on demand.
 *
 * @param {number|string} requestId
 * @param {string} [caption] context line shown above the image
 */
async function openAttendanceProof(requestId, caption) {
  var modalEl = document.getElementById('correctionProofModal');
  var image = document.getElementById('correctionProofModalImage');
  var loading = document.getElementById('correctionProofLoading');
  var errorBox = document.getElementById('correctionProofError');
  var captionEl = document.getElementById('correctionProofCaption');
  if (!modalEl || !image || !window.bootstrap) return;

  var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  // A request key invalidates a fetch that resolves after the modal closed
  // or after the user opened a different proof.
  var requestKey = String((Number(modalEl.dataset.proofRequest) || 0) + 1);
  modalEl.dataset.proofRequest = requestKey;

  if (captionEl) captionEl.textContent = caption || '';
  if (errorBox) {
    errorBox.textContent = '';
    errorBox.classList.add('d-none');
  }
  image.removeAttribute('src');
  image.classList.add('d-none');
  if (loading) loading.classList.remove('d-none');

  if (!modalEl.dataset.proofBound) {
    modalEl.dataset.proofBound = '1';
    modalEl.addEventListener('hidden.bs.modal', function () {
      modalEl.dataset.proofRequest = String((Number(modalEl.dataset.proofRequest) || 0) + 1);
      image.removeAttribute('src');
      image.classList.add('d-none');
      if (loading) loading.classList.add('d-none');
    });
  }

  modal.show();

  try {
    var result = typeof api !== 'undefined' ? await api.attendanceCorrectionProof(requestId) : null;
    if (modalEl.dataset.proofRequest !== requestKey) return;

    var src = result && typeof result.proofImage === 'string' ? result.proofImage : '';
    // Defence in depth: the server already validates the data URL, and this
    // keeps a malformed response from becoming an <img> payload.
    if (!/^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src)) {
      throw new Error('This request has no readable proof image.');
    }
    image.src = src;
    image.classList.remove('d-none');
  } catch (error) {
    if (modalEl.dataset.proofRequest !== requestKey) return;
    if (errorBox) {
      errorBox.textContent = error.message || 'The proof image could not be loaded.';
      errorBox.classList.remove('d-none');
    }
  } finally {
    if (modalEl.dataset.proofRequest === requestKey && loading) {
      loading.classList.add('d-none');
    }
  }
}

/* ============================================================
   Theme Management
   ============================================================ */

/** Read the saved theme and apply it before first paint.
 * Auth screens intentionally stick to the dark campus palette by default to
 * match the last approved identity treatment. */
function initTheme() {
  const isAuthPage = /\/(login|signup|change-password)\.html$/.test(window.location.pathname);
  const savedTheme = localStorage.getItem('theme');
  const resolvedTheme = savedTheme || (isAuthPage ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', resolvedTheme);
}

/** Toggle between light and dark mode, persist the choice. */
function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  updateThemeIcons(newTheme);
}

/** Sync all theme-toggle icons (moon ↔ sun) to the current theme. */
function updateThemeIcons(theme) {
  document.querySelectorAll('[data-theme-icon]').forEach(icon => {
    icon.className = theme === 'dark' ? 'bi bi-sun' : 'bi bi-moon';
  });
}

// Initialise theme on page load.
document.addEventListener('DOMContentLoaded', function () {
  initTheme();
  updateThemeIcons(document.documentElement.getAttribute('data-theme') || 'light');

  // Expose the visual current-page state to assistive technology as well.
  document.querySelectorAll('.role-nav a.active, .student-nav a.active').forEach(link => {
    link.setAttribute('aria-current', 'page');
  });

  document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
    btn.addEventListener('click', toggleTheme);
  });

  initResponsiveShell();
  initNotifications();
  initUserDropdown();
});

/**
 * Provide one keyboard-safe announcement panel for every workspace. Pages may
 * include the panel in their markup, but it is created on demand elsewhere so
 * a bell never looks actionable without actually doing something.
 */
function initNotifications() {
  const triggers = Array.from(document.querySelectorAll('[aria-label="Notifications"]'));
  if (!triggers.length) return;

  let panel = document.getElementById('notificationPanel');
  let backdrop = document.getElementById('notificationBackdrop');
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'notification-panel';
    panel.id = 'notificationPanel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'notificationPanelTitle');
    panel.innerHTML = '<div class="notification-panel-head"><div><p class="section-kicker">Campus updates</p><h2 id="notificationPanelTitle">Notifications</h2></div><button class="icon-button notification-close" type="button" aria-label="Close notifications"><i class="bi bi-x-lg"></i></button></div><div class="notification-panel-list" id="notificationList"></div>';
    document.body.appendChild(panel);
  }
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'notification-backdrop';
    backdrop.id = 'notificationBackdrop';
    backdrop.hidden = true;
    document.body.appendChild(backdrop);
  }

  const list = panel.querySelector('.notification-panel-list');
  const closeButton = panel.querySelector('.notification-close');
  let trigger = null;

  triggers.forEach(button => {
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => open(button));
  });

  function render() {
    if (!list) return;
    const announcements = typeof getAnnouncements === 'function' ? getAnnouncements() : [];
    list.replaceChildren();
    if (!announcements.length) {
      const empty = document.createElement('p');
      empty.className = 'notification-empty';
      empty.textContent = 'No announcements yet.';
      list.appendChild(empty);
      return;
    }
    announcements.forEach(item => {
      const row = document.createElement('div');
      row.className = 'announcement-item';
      const title = document.createElement('strong');
      title.textContent = item.title || 'Campus update';
      const detail = document.createElement('small');
      detail.textContent = item.detail || '';
      row.append(title, detail);
      list.appendChild(row);
    });
  }

  function open(source) {
    trigger = source || document.activeElement;
    render();
    panel.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add('notification-open');
    triggers.forEach(button => button.setAttribute('aria-expanded', 'true'));
    window.setTimeout(() => closeButton && closeButton.focus(), 0);
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('notification-open');
    triggers.forEach(button => button.setAttribute('aria-expanded', 'false'));
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  }

  closeButton && closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', event => {
    if (panel.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(panel.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  window.openSharedNotifications = open;
}

/**
 * Turn the shared workspace sidebar into an accessible off-canvas drawer on
 * small screens. Markup is added here so every student, SSC, and administrator
 * page gets the same navigation without duplicating controls across 21 files.
 */
function initResponsiveShell() {
  const sidebar = document.querySelector('.app-sidebar, .role-sidebar, .student-sidebar');
  const topbar = document.querySelector('.app-topbar, .role-topbar, .student-topbar');
  if (!sidebar || !topbar || topbar.querySelector('.app-mobile-menu-toggle')) return;

  // Match the breakpoint used for the off-canvas drawer in the CSS.
  const mobileQuery = window.matchMedia('(max-width: 650px)');
  const sidebarId = sidebar.id || 'workspace-navigation';
  sidebar.id = sidebarId;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'icon-button app-mobile-menu-toggle';
  toggle.setAttribute('aria-label', 'Open navigation');
  toggle.setAttribute('aria-controls', sidebarId);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = '<i class="bi bi-list" aria-hidden="true"></i>';
  topbar.prepend(toggle);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'icon-button app-drawer-close';
  closeButton.setAttribute('aria-label', 'Close navigation');
  closeButton.innerHTML = '<i class="bi bi-x-lg" aria-hidden="true"></i>';
  sidebar.prepend(closeButton);

  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.className = 'app-nav-backdrop';
  backdrop.setAttribute('aria-label', 'Close navigation');
  backdrop.hidden = true;
  sidebar.insertAdjacentElement('afterend', backdrop);

  let restoreFocus = false;

  function setDrawer(open, options) {
    const shouldOpen = Boolean(open && mobileQuery.matches);
    const settings = options || {};

    sidebar.classList.toggle('is-open', shouldOpen);
    backdrop.classList.toggle('is-visible', shouldOpen);
    backdrop.hidden = !shouldOpen;
    document.body.classList.toggle('nav-drawer-open', shouldOpen);
    toggle.setAttribute('aria-expanded', String(shouldOpen));
    toggle.setAttribute('aria-label', shouldOpen ? 'Close navigation' : 'Open navigation');
    toggle.querySelector('i').className = shouldOpen ? 'bi bi-x-lg' : 'bi bi-list';

    if (mobileQuery.matches) {
      sidebar.inert = !shouldOpen;
      sidebar.setAttribute('aria-hidden', String(!shouldOpen));
    } else {
      sidebar.inert = false;
      sidebar.removeAttribute('aria-hidden');
    }

    if (shouldOpen) {
      restoreFocus = true;
      const activeLink = sidebar.querySelector('a[aria-current="page"]') || sidebar.querySelector('a, button');
      if (activeLink) {
        window.setTimeout(() => {
          if (toggle.getAttribute('aria-expanded') === 'true') activeLink.focus();
        }, 80);
      }
    } else if (settings.returnFocus && restoreFocus) {
      restoreFocus = false;
      toggle.focus();
    }
  }

  toggle.addEventListener('click', () => {
    setDrawer(toggle.getAttribute('aria-expanded') !== 'true', { returnFocus: true });
  });
  closeButton.addEventListener('click', () => setDrawer(false, { returnFocus: true }));
  backdrop.addEventListener('click', () => setDrawer(false, { returnFocus: true }));
  sidebar.addEventListener('click', event => {
    if (event.target.closest('a')) setDrawer(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setDrawer(false, { returnFocus: true });
      return;
    }

    if (event.key === 'Tab' && toggle.getAttribute('aria-expanded') === 'true') {
      const focusable = Array.from(sidebar.querySelectorAll('a[href], button:not([disabled])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  mobileQuery.addEventListener('change', () => setDrawer(false));

  setDrawer(false);
}


/* ============================================================
   Date & Badge Helpers
   ============================================================ */

/**
 * Format a "YYYY-MM-DD" string into a human-readable date.
 * @param {string} dateStr
 * @returns {string} e.g. "Sep 8, 2026"
 */
function formatDate(dateStr) {
  const options = { year: 'numeric', month: 'short', day: 'numeric' };
  return new Date(dateStr).toLocaleDateString(undefined, options);
}

/**
 * Return the severity badge HTML for a sanction level.
 * @param {'warning'|'probation'|'suspension'} severity
 * @returns {string} innerHTML for a <span class="badge …">
 */
function severityBadge(severity) {
  const classMap = {
    warning:    'badge-warning-severity',
    probation:  'badge-probation-severity',
    suspension: 'badge-suspension-severity',
  };
  const cls = classMap[severity] || 'bg-secondary';
  const label = severity.charAt(0).toUpperCase() + severity.slice(1);
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

/**
 * Format a sanction row for display. Pending recommendations carry the
 * internal `r<id>` key used by the review endpoint, while finalized records
 * have numeric IDs. The UI shows stable public labels in both cases.
 *
 * @param {{id: (string|number), status?: string}} sanction
 * @returns {string} e.g. "REC_002" or "SAN_014"
 */
function sanctionPublicId(sanction) {
  const raw = String(sanction && sanction.id != null ? sanction.id : '');
  const match = raw.match(/^r?(\d+)$/);
  if (!match) return raw || '—';
  const label = match[1].padStart(3, '0');
  const isRecommendation = raw.startsWith('r') || (sanction && sanction.status === 'pending-review');
  return (isRecommendation ? 'REC_' : 'SAN_') + label;
}

/**
 * Show or hide an empty-state container based on whether
 * data is present.
 *
 * @param {string}  containerId — DOM id of the empty-state element
 * @param {boolean} hasData     — true = hide empty state, false = show it
 */
function toggleEmptyState(containerId, hasData) {
  const empty = document.getElementById(containerId);
  if (empty) {
    empty.classList.toggle('d-none', hasData);
  }
}

/**
 * Build a consistent in-table empty state row.
 *
 * @param {number} colspan  number of table columns to span
 * @param {string} title    short headline
 * @param {string} [hint]   optional supporting sentence
 * @param {string} [icon]   Bootstrap Icons suffix, e.g. 'bi-people'
 * @returns {string} a complete <tr> for a <tbody>
 */
function emptyTableRow(colspan, title, hint, icon) {
  return '<tr><td colspan="' + Number(colspan || 1) + '" class="role-empty-cell">' +
    '<i class="bi ' + escapeHtml(icon || 'bi-inbox') + '" aria-hidden="true"></i>' +
    '<strong>' + escapeHtml(title || 'Nothing to show') + '</strong>' +
    (hint ? '<span>' + escapeHtml(hint) + '</span>' : '') +
    '</td></tr>';
}


/* ============================================================
   Grouped Student List (Department → Course → Year Level)
   ------------------------------------------------------------
   Shared by the SSC and Admin "Manage Students" pages. Renders the
   student table as collapsible department + course sections (Year
   Level stays a column so rows stay compact), backed by the three
   org filter dropdowns and a name/ID/email search box. Each page
   supplies a renderRow(student) callback for its own columns — the
   grouping / filter / collapse behaviour lives here.
   ============================================================ */

/**
 * Initialise the grouped, filterable student list on a manage-students
 * page: populate the filter dropdowns, wire search + collapse, render
 * into the table body. Re-render later via refreshGroupedStudentList().
 *
 * @param {object} opts
 * @param {string}   [opts.tbodyId='studentTableBody']
 * @param {string}   [opts.countId='studentCount']
 * @param {string}   [opts.departmentFilterId='filterDepartment']
 * @param {string}   [opts.courseFilterId='filterCourse']
 * @param {string}   [opts.yearFilterId='filterYear']
 * @param {string}   [opts.blockFilterId='filterBlock']
 * @param {string}   [opts.searchId='studentSearch']
 * @param {number}   [opts.colspan=5]
 * @param {function(object):boolean} [opts.filter] - optional extra student predicate
 * @param {function(object):string} opts.renderRow - returns the cell HTML for one student row
 */
function initGroupedStudentList(opts) {
  const tbody = document.getElementById(opts.tbodyId || 'studentTableBody');
  if (!tbody) return;

  const deptSel   = document.getElementById(opts.departmentFilterId || 'filterDepartment');
  const courseSel = document.getElementById(opts.courseFilterId   || 'filterCourse');
  const yearSel   = document.getElementById(opts.yearFilterId     || 'filterYear');
  const blockSel  = document.getElementById(opts.blockFilterId    || 'filterBlock');
  const searchEl  = document.getElementById(opts.searchId         || 'studentSearch');
  const colspan   = opts.colspan || 5;
  const taxonomy  = getStudentOrgTaxonomy();

  // ── Filter dropdown options ──
  if (deptSel) {
    deptSel.innerHTML = '<option value="">All Departments</option>' +
      taxonomy.departments.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('') +
      `<option value="${UNASSIGNED}">${UNASSIGNED}</option>`;
  }
  if (yearSel) {
    yearSel.innerHTML = '<option value="">All Year Levels</option>' +
      taxonomy.yearLevels.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(getStudentYearLabel(y))}</option>`).join('') +
      `<option value="${UNASSIGNED}">${UNASSIGNED}</option>`;
  }

  // Course options follow the currently selected Department.
  function fillCourseOptions(selectedDept) {
    if (!courseSel) return;
    let courses;
    if (!selectedDept) {
      courses = [];
      Object.values(taxonomy.coursesByDept).forEach(list => list.forEach(c => courses.push(c)));
      courses.push(UNASSIGNED);
    } else if (selectedDept === UNASSIGNED) {
      courses = [UNASSIGNED];
    } else {
      courses = taxonomy.coursesByDept[selectedDept] || [];
    }
    courseSel.innerHTML = '<option value="">All Courses</option>' +
      courses.map(c => {
        const label = c === UNASSIGNED ? UNASSIGNED : programLabel(c);
        return `<option value="${escapeHtml(c)}">${escapeHtml(label)}</option>`;
      }).join('');
  }

  function readState() {
    return {
      department: deptSel   ? deptSel.value  : '',
      course:     courseSel ? courseSel.value : '',
      yearLevel:  yearSel   ? yearSel.value  : '',
      block:      blockSel  ? blockSel.value : '',
      query:      searchEl  ? searchEl.value : '',
    };
  }

  // Block labels are free text entered at sign-up, so derive the filter
  // options from the loaded roster instead of a fixed taxonomy.
  function fillBlockOptions() {
    if (!blockSel) return;
    const selected = blockSel.value;
    const blocks = [];
    getUsers().filter(u => u.role === 'student').forEach(u => {
      const block = String(u.block || '').trim();
      if (block && !blocks.includes(block)) blocks.push(block);
    });
    blocks.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    blockSel.innerHTML = '<option value="">All Blocks</option>' +
      blocks.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    if (blocks.includes(selected)) blockSel.value = selected;
  }

  function render() {
    fillBlockOptions();
    const state   = readState();
    const all     = getUsers().filter(u => u.role === 'student')
      .filter(u => typeof opts.filter !== 'function' || opts.filter(u));
    const visible = applyStudentFilters(all, state, state.query);

    const countEl = document.getElementById(opts.countId || 'studentCount');
    if (countEl) countEl.textContent = `${visible.length} of ${all.length} students`;

    tbody.innerHTML = '';

    if (!visible.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${colspan}" class="role-empty-cell">` +
        '<i class="bi bi-people" aria-hidden="true"></i>' +
        '<strong>No students match the current filters</strong>' +
        '<span>Try clearing a filter or searching a different name.</span></td>';
      tbody.appendChild(tr);
      return;
    }

    groupStudentsByOrg(visible).forEach(group => {
      const studentCount = group.courses.reduce((n, c) => n + c.students.length, 0);
      tbody.appendChild(makeOrgHeadRow(group.department, `${group.courses.length} course${group.courses.length === 1 ? '' : 's'} · ${studentCount} student${studentCount === 1 ? '' : 's'}`, colspan, 'dept'));
      group.courses.forEach(courseGroup => {
        tbody.appendChild(makeOrgHeadRow(courseGroup.course, `${courseGroup.students.length} student${courseGroup.students.length === 1 ? '' : 's'}`, colspan, 'course'));
        courseGroup.students.forEach(student => {
          const tr = document.createElement('tr');
          tr.dataset.kind = 'student';
          tr.innerHTML = opts.renderRow(student);
          tbody.appendChild(tr);
        });
      });
    });
  }

  // Collapse/expand everything below a department or course header.
  function toggleGroup(headRow) {
    const level = headRow.dataset.level; // 'dept' | 'course'
    const willCollapse = !headRow.classList.contains('org-group-collapsed');
    headRow.classList.toggle('org-group-collapsed', willCollapse);
    headRow.setAttribute('aria-expanded', String(!willCollapse));
    let node = headRow.nextElementSibling;
    while (node) {
      if (node.dataset.kind === 'org-head') {
        // Stop at the next department head (after a dept header) or the
        // next course/department head (after a course header).
        if (level === 'course' || node.dataset.level === 'dept') break;
      }
      node.classList.toggle('org-group-hidden', willCollapse);
      node = node.nextElementSibling;
    }
  }

  tbody.addEventListener('click', (e) => {
    const head = e.target.closest && e.target.closest('.org-group-head');
    if (head) toggleGroup(head);
  });
  tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const head = e.target.closest && e.target.closest('.org-group-head');
    if (head) { e.preventDefault(); toggleGroup(head); }
  });

  // ── Filter + search wiring ──
  if (deptSel) deptSel.addEventListener('change', () => {
    fillCourseOptions(deptSel.value);
    // A course picked under the previous department may no longer exist.
    if (courseSel && courseSel.value && !courseSel.querySelector(`option[value="${courseSel.value}"]`)) {
      courseSel.value = '';
    }
    render();
  });
  if (courseSel) courseSel.addEventListener('change', render);
  if (yearSel)   yearSel.addEventListener('change', render);
  if (blockSel)  blockSel.addEventListener('change', render);
  if (searchEl)  searchEl.addEventListener('input', render);

  fillCourseOptions(deptSel ? deptSel.value : '');
  render();

  // Expose a re-render hook so add/edit/delete handlers can refresh.
  window.__refreshStudentList = render;
}

/** Re-render the grouped student list with the current filter state. */
function refreshGroupedStudentList() {
  if (typeof window.__refreshStudentList === 'function') window.__refreshStudentList();
}

/**
 * Build a collapsible department (level 'dept') or course (level
 * 'course') header row spanning every column.
 */
function makeOrgHeadRow(title, pillText, colspan, level) {
  const tr = document.createElement('tr');
  tr.dataset.kind  = 'org-head';
  tr.dataset.level = level;
  tr.className = 'org-group-head ' + (level === 'dept' ? 'org-group-head-dept' : 'org-group-head-course');
  tr.setAttribute('role', 'button');
  tr.setAttribute('tabindex', '0');
  tr.setAttribute('aria-expanded', 'true');
  const icon = level === 'dept' ? 'bi-buildings-fill' : 'bi-journal-text';
  tr.innerHTML =
    `<td colspan="${colspan}">` +
      '<div class="org-group-label">' +
        '<span class="org-group-chevron"><i class="bi bi-chevron-down"></i></span>' +
        `<i class="bi ${icon} org-group-icon"></i>` +
        `<span class="org-group-title">${escapeHtml(title)}</span>` +
        `<span class="org-group-pill">${escapeHtml(pillText)}</span>` +
      '</div>' +
    '</td>';
  return tr;
}

/**
 * Populate the Department/Course/Year selects inside Add/Edit student
 * modals; the course options follow the selected department. Pass an
 * optional `initial` record to pre-fill existing values for editing.
 *
 * @returns {{ deptSel: HTMLSelectElement, courseSel: HTMLSelectElement, yearSel: HTMLSelectElement }}
 */
function initOrgModalSelects(deptId, courseId, yearId, initial, options) {
  const deptSel   = document.getElementById(deptId);
  const courseSel = courseId ? document.getElementById(courseId) : null;
  const yearSel   = document.getElementById(yearId);
  const init      = initial || {};
  const settings  = options || {};
  const taxonomy  = getStudentOrgTaxonomy();
  const allowUnassigned = settings.includeUnassigned !== false;
  const initOrg   = normalizeStudentOrg({
    department: init.department,
    program: init.course || init.program,
    yearLevel: init.yearLevel,
  });

  function fillDepartment(value) {
    if (!deptSel) return;
    deptSel.innerHTML = '<option value="">Select department…</option>' +
      taxonomy.departments.filter(d => allowUnassigned || d !== UNASSIGNED)
        .map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('') +
      (allowUnassigned ? `<option value="${UNASSIGNED}">${UNASSIGNED}</option>` : '');
    deptSel.value = allowUnassigned || value !== UNASSIGNED ? (value || '') : '';
  }

  function fillCourse(department, value) {
    if (!courseSel) return;
    const courses = department
      ? (department === UNASSIGNED ? [UNASSIGNED] : (taxonomy.coursesByDept[department] || []))
          .filter(course => allowUnassigned || course !== UNASSIGNED)
      : [];
    const placeholder = department ? 'Select course…' : 'Select department first';
    courseSel.innerHTML = `<option value="">${placeholder}</option>` +
      courses.map(course => {
        const label = course === UNASSIGNED ? UNASSIGNED : programLabel(course);
        return `<option value="${escapeHtml(course)}">${escapeHtml(label)}</option>`;
      }).join('');
    courseSel.value = allowUnassigned || value !== UNASSIGNED ? (value || '') : '';
  }

  function fillYear(value) {
    if (!yearSel) return;
    yearSel.innerHTML = '<option value="">Select year…</option>' +
      taxonomy.yearLevels.filter(y => allowUnassigned || y !== UNASSIGNED)
        .map(y => `<option value="${escapeHtml(y)}">${escapeHtml(getStudentYearLabel(y))}</option>`).join('');
    yearSel.value = value || '';
  }

  function bindPicker(select) {
    if (!select) return;

    const group = select.closest('.input-group');
    if (group) group.classList.add('auth-select-group');

    // The signup form is taller than its scroll panel. Move the year select
    // into the upper part of that panel before the browser opens its native
    // menu, leaving enough viewport below it for the options to open down.
    if (select === yearSel) {
      select.addEventListener('pointerdown', function () {
        const panel = select.closest('.auth-form-panel--scroll');
        if (!panel) return;
        const panelRect = panel.getBoundingClientRect();
        const selectRect = select.getBoundingClientRect();
        const desiredTop = panelRect.top + panel.clientHeight * 0.3;
        panel.scrollTop += selectRect.top - desiredTop;
      });
    }
  }

  bindPicker(deptSel);
  bindPicker(courseSel);
  bindPicker(yearSel);

  fillDepartment(initOrg.department);
  fillCourse(initOrg.department, initOrg.course);
  fillYear(init.yearLevel);

  if (deptSel && courseSel) {
    deptSel.addEventListener('change', () => fillCourse(deptSel.value, ''));
    // Keep the school in lock-step with the program. This is also enforced
    // server-side, so a mismatched pair can never be persisted.
    courseSel.addEventListener('change', () => {
      const school = departmentForProgram(courseSel.value);
      if (school) deptSel.value = school;
    });
  }

  return { deptSel, courseSel, yearSel };
}

/**
 * Year Level badge HTML for a student row in a grouped list.
 * @returns {string}
 */
function yearBadge(student) {
  const org      = normalizeStudentOrg(student);
  const assigned = org.yearLevel !== UNASSIGNED;
  const cls      = assigned ? 'year-badge' : 'year-badge year-unassigned';
  const label    = assigned ? getStudentYearLabel(org.yearLevel) : UNASSIGNED;
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}


/* ============================================================
   User Account Dropdown
   ------------------------------------------------------------
   Shared open/close behaviour for the account menu in the topbar.
   Every role dashboard ships the same markup, so the wiring lives
   here instead of being copied into each page.
   ============================================================ */

/**
 * Wire the topbar account dropdown: the toggle opens and closes the
 * menu, a click anywhere outside dismisses it, and Escape closes it
 * and returns focus to the toggle.
 */
function initUserDropdown() {
  const toggle = document.getElementById('userDropdownToggle');
  const menu = document.getElementById('userDropdownMenu');
  if (!toggle || !menu) return;

  toggle.addEventListener('click', function (event) {
    event.stopPropagation();
    const open = menu.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', function () {
    menu.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  });

  menu.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    menu.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  });
}


/* ============================================================
   Global Search
   ------------------------------------------------------------
   Cross-entity search over the topbar search box. The markup and
   styling are shared; only the destination for each result group is
   role-specific, so callers pass a links map.
   ============================================================ */

/**
 * Wire the global search box and render grouped results.
 *
 * @param {Object} links — role-specific destinations, e.g.
 *   { students: 'admin-manage-students.html', events: 'admin-reports.html' }
 */
function initGlobalSearch(links) {
  const input = document.getElementById('globalSearchInput');
  const results = document.getElementById('searchResults');
  const clear = document.getElementById('searchClear');
  const wrap = document.getElementById('globalSearch');
  if (!input || !results) return;

  const targets = Object.assign({
    students: '#',
    events: '#',
  }, links || {});

  function close() {
    results.classList.remove('open');
  }

  function render(query) {
    const users = getUsers();
    const events = getEvents();
    let html = '';

    const students = users.filter(u => u.role === 'student'
      && (u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query)));
    if (students.length) {
      html += '<div class="search-result-group"><i class="bi bi-people"></i> Students</div>';
      students.slice(0, 5).forEach(s => {
        html += '<a class="search-result-item" href="' + escapeHtml(targets.students) + '"><i class="bi bi-person"></i> '
          + escapeHtml(s.name)
          + ' <small style="color:var(--color-text-muted);margin-left:auto">' + escapeHtml(s.email) + '</small></a>';
      });
    }

    const officers = users.filter(u => u.role === 'ssc-officer'
      && (u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query)));
    if (officers.length && targets.officers) {
      html += '<div class="search-result-group"><i class="bi bi-person-badge"></i> Officers</div>';
      officers.slice(0, 5).forEach(o => {
        html += '<a class="search-result-item" href="' + escapeHtml(targets.officers) + '"><i class="bi bi-person-badge"></i> '
          + escapeHtml(o.name)
          + ' <small style="color:var(--color-text-muted);margin-left:auto">' + escapeHtml(o.email) + '</small></a>';
      });
    }

    const matchedEvents = events.filter(e => e.name.toLowerCase().includes(query)
      || e.location.toLowerCase().includes(query)
      || String(e.publicId || '').toLowerCase().includes(query));
    if (matchedEvents.length) {
      html += '<div class="search-result-group"><i class="bi bi-calendar-event"></i> Events</div>';
      matchedEvents.slice(0, 5).forEach(ev => {
        html += '<a class="search-result-item" href="' + escapeHtml(targets.events) + '"><i class="bi bi-calendar-event"></i> '
          + escapeHtml(ev.name)
          + ' <small style="color:var(--color-text-muted);margin-left:auto">' + escapeHtml(ev.date) + '</small></a>';
      });
    }

    if (!html) html = '<div class="search-no-results">No results found for "' + escapeHtml(query) + '"</div>';
    results.innerHTML = html;
    results.classList.add('open');
  }

  input.addEventListener('input', function () {
    const query = this.value.trim().toLowerCase();
    if (clear) clear.classList.toggle('visible', query.length > 0);
    if (query.length < 2) { close(); return; }
    render(query);
  });

  input.addEventListener('focus', function () {
    if (this.value.trim().length >= 2) results.classList.add('open');
  });

  document.addEventListener('click', function (event) {
    if (wrap && !wrap.contains(event.target)) close();
  });

  if (clear) {
    clear.addEventListener('click', function () {
      input.value = '';
      close();
      this.classList.remove('visible');
      input.focus();
    });
  }
}

/* ============================================================
   Reports — shared attendance report and semester matrix
   ------------------------------------------------------------
   Loaded by admin-reports.html and ssc-reports.html after the
   role script. The role script calls ReportsPage.init() once the
   server session has been verified.

   The endpoints return the row/matrix shapes; this module owns the
   filters, grouped attendance print sections, semester matrix,
   CSV export and print metadata.
   ============================================================ */

/* global api, isApiEnabled, getEvents, setEvents, getUsers, getAttendance,
   getStudentOrgTaxonomy, getStudentYearLabel,
   normalizeStudentOrg, normalizeDepartmentName, programLabel, sameId,
   formatDate, escapeHtml, showToast */

(function () {
  'use strict';

  var initialized = false;
  var state = {
    rows: [],
    filters: null,
    generatedAt: null,
    sanctionEvents: [],
    sanctionRows: [],
    sanctionRange: null,
    sanctionGeneratedAt: null
  };

  function byId(id) {
    return document.getElementById(id);
  }

  // Sanction report filter options that mirror the backend's allowed values.
  // The semester column is seeded as "N/A" in this database, but the report
  // UI still gives staff the three real terms they expect; an empty selection
  // means "all terms".
  var SEMESTERS = [
    '1st Semester',
    '2nd Semester',
    'Summer',
  ];

  // Local department picker fallback used when the backend has not served a
  // student-org taxonomy (for example, an unauthenticated preview). These are
  // the same three schools the seed data and ProgramCatalog use, so the local
  // and server paths agree.
  var DEPARTMENT_OPTIONS = [
    { value: 'School of Computer Studies', label: 'School of Computer Studies' },
    { value: 'School of Nursing', label: 'School of Nursing' },
    { value: 'School of Business Management', label: 'School of Business Management' },
  ];

  function valueOf(id) {
    var element = byId(id);
    return element ? element.value : '';
  }

  function selectedEventIds() {
    var select = byId('filterEvent');
    if (!select) return [];
    return Array.prototype.filter.call(select.options, function (option) {
      return option.selected && option.value !== '';
    }).map(function (option) { return option.value; });
  }

  function fillSelect(select, placeholder, options, selected) {
    if (!select) return;
    var html = '<option value="">' + escapeHtml(placeholder) + '</option>';
    options.forEach(function (option) {
      html += '<option value="' + escapeHtml(option.value) + '">' + escapeHtml(option.label) + '</option>';
    });
    select.innerHTML = html;
    if (selected && options.some(function (option) { return option.value === selected; })) {
      select.value = selected;
    }
  }

  function eventOptions() {
    return getEvents().map(function (event) {
      return {
        value: String(event.id),
        label: (event.publicId ? event.publicId + ' — ' : '') + event.name + ' — ' + formatDate(event.date)
      };
    });
  }

  function populateEventSelect() {
    var select = byId('reportEvent');
    if (!select) return;
    var selected = select.value;
    fillSelect(select, 'All events', eventOptions(), selected);
  }

  function populateDepartmentSelect() {
    var select = byId('reportDepartment');
    if (!select) return;
    var selected = select.value;
    var taxonomy = getStudentOrgTaxonomy();
    fillSelect(select, 'All departments', taxonomy.departments.map(function (department) {
      return { value: department, label: department };
    }), selected);
  }

  function populateProgramSelect() {
    var select = byId('reportProgram');
    if (!select) return;
    var selected = select.value;
    var department = valueOf('reportDepartment');
    var taxonomy = getStudentOrgTaxonomy();
    var courses = department
      ? (taxonomy.coursesByDept[department] || [])
      : Object.keys(taxonomy.coursesByDept).reduce(function (all, key) {
          return all.concat(taxonomy.coursesByDept[key]);
        }, []);

    // A department can own several programs; a program belongs to exactly
    // one department, so dedupe defensively if the taxonomy is extended.
    courses = courses.filter(function (course, index) {
      return courses.indexOf(course) === index;
    });

    fillSelect(select, 'All programs', courses.map(function (course) {
      return { value: course, label: programLabel(course) };
    }), selected);
  }

  function populateYearSelect() {
    var select = byId('reportYear');
    if (!select) return;
    var selected = select.value;
    var taxonomy = getStudentOrgTaxonomy();
    fillSelect(select, 'All year levels', taxonomy.yearLevels.map(function (year) {
      return { value: year, label: getStudentYearLabel(year) };
    }), selected);
  }

  function populateSanctionSemesterSelect() {
    var select = byId('sanctionSemesterFilter');
    if (!select) return;
    var selected = select.value;
    // Derive the semester list from the events actually in the database so
    // the filter can only pick terms that exist. When the cache is empty we
    // fall back to the three academic terms staff expect.
    var events = getEvents();
    var semesters = events.length
      ? Array.prototype.filter.call(
          events.map(function (event) { return event.semester; }),
          function (semester) { return typeof semester === 'string' && semester !== ''; }
        )
        .reduce(function (seen, semester) {
          if (seen.indexOf(semester) === -1) seen.push(semester);
          return seen;
        }, [])
        .sort()
      : SEMESTERS.slice();
    fillSelect(select, 'All Semesters',
      semesters.map(function (semester) {
        return { value: semester, label: semester };
      }), selected);
  }

  function populateSanctionDepartmentSelect() {
    var select = byId('sanctionDepartmentFilter');
    if (!select) return;
    var selected = select.value;
    // Prefer the database taxonomy when the backend has served one; fall back
    // to the local prototype taxonomy otherwise so the page is still usable
    // offline.
    var taxonomy = (typeof getStudentOrgTaxonomy === 'function')
      ? getStudentOrgTaxonomy()
      : null;
    var departments = (taxonomy && Array.isArray(taxonomy.departments))
      ? taxonomy.departments.slice()
      : DEPARTMENT_OPTIONS.map(function (d) { return d.value; });
    fillSelect(select, 'All departments',
      departments.map(function (department) {
        return { value: department, label: department };
      }), selected);
  }

  function populateSanctionProgramSelect() {
    var select = byId('sanctionProgramFilter');
    if (!select) return;
    var selected = select.value;
    var department = valueOf('sanctionDepartmentFilter');
    var taxonomy = (typeof getStudentOrgTaxonomy === 'function')
      ? getStudentOrgTaxonomy()
      : null;
    var coursesByDept = (taxonomy && taxonomy.coursesByDept && typeof taxonomy.coursesByDept === 'object')
      ? taxonomy.coursesByDept
      : {};
    var courses = department
      ? (coursesByDept[department] || [])
      : Object.keys(coursesByDept).reduce(function (all, key) {
          return all.concat(coursesByDept[key]);
        }, []);

    courses = courses.filter(function (course, index) {
      return courses.indexOf(course) === index;
    });

    fillSelect(select, 'All programs', courses.map(function (course) {
      return { value: course, label: programLabel(course) };
    }), selected);
  }

  function readFilters() {
    return {
      eventId: valueOf('reportEvent'),
      department: valueOf('reportDepartment'),
      program: valueOf('reportProgram'),
      yearLevel: valueOf('reportYear'),
      semester: valueOf('reportSemester')
    };
  }

  function readSanctionFilters() {
    return {
      eventIds: selectedEventIds(),
      semester: valueOf('sanctionSemesterFilter'),
      department: valueOf('sanctionDepartmentFilter'),
      program: valueOf('sanctionProgramFilter')
    };
  }

  function rowValue(row, key, fallback) {
    var value = row[key];
    return value === undefined || value === null || value === '' ? fallback : value;
  }

  /* ── Event category helpers ─────────────────────────────────── */

  function eventCategory(event) {
    var value = event || {};
    var category = String(value.category || value.eventCategory || value.type || '').toLowerCase();
    if (category === 'major' || category === 'minor') return category;
    if (value.mandatory === true || value.eventType === 'mandatory' || value.event_type === 'mandatory') {
      return 'major';
    }
    return 'minor';
  }

  function isMajorEvent(event) {
    return eventCategory(event) === 'major';
  }

  function isMandatoryEvent(event) {
    return event.mandatory === true ||
      event.eventType === 'mandatory' ||
      event.event_type === 'mandatory';
  }

  function timestampLabel(value) {
    var raw = String(value === undefined || value === null ? '' : value).trim();
    if (!raw) return '';
    var match = raw.match(/(\d{2}):(\d{2})/);
    return match ? match[1] + ':' + match[2] : '';
  }

  function checkOutLabel(record) {
    if (!record) return '';
    return timestampLabel(record.checkOutTimeLabel) ||
      timestampLabel(record.checkOutTime) ||
      timestampLabel(record.timeOut);
  }

  function localAttendanceReport(filters) {
    var userMap = new Map(getUsers().map(function (user) { return [String(user.id), user]; }));
    var eventMap = new Map(getEvents().map(function (event) { return [String(event.id), event]; }));

    return getAttendance().filter(function (record) {
      if (filters.eventId && !sameId(record.eventId, filters.eventId)) return false;

      var student = userMap.get(String(record.studentId)) || {};
      var org = normalizeStudentOrg(student);
      if (filters.department && org.department !== filters.department) return false;
      if (filters.program && org.course !== filters.program) return false;
      if (filters.yearLevel && org.yearLevel !== filters.yearLevel) return false;
      return true;
    }).map(function (record) {
      var student = userMap.get(String(record.studentId)) || {};
      var event = eventMap.get(String(record.eventId)) || {};
      var org = normalizeStudentOrg(student);
      var status = String(record.status || 'present').toLowerCase();
      var checkOut = checkOutLabel(record);
      return {
        id: record.id,
        eventId: record.eventId,
        eventPublicId: event.publicId || null,
        eventName: event.name || 'Unknown event',
        eventDate: event.date || record.date,
        eventStartTime: event.startTime || event.time || null,
        eventEndTime: event.endTime || null,
        eventCategory: eventCategory(event),
        studentId: record.studentId,
        studentPublicId: student.publicId || null,
        studentName: student.name || 'Unknown student',
        studentIdNumber: student.studentIdNumber || null,
        department: org.department,
        program: org.course,
        yearLevel: org.yearLevel,
        block: student.block || null,
        date: record.date,
        time: record.time,
        checkInTime: record.date && record.time ? record.date + ' ' + record.time : null,
        checkOutTimeLabel: checkOut || null,
        status: status,
        statusLabel: status === 'late' ? 'Late' : 'Present'
      };
    });
  }

  var DEPARTMENT_ACRONYMS = {
    'School of Computer Studies': 'SCS',
    'School of Nursing': 'SON',
    'School of Business Management': 'SBM'
  };

  function departmentAcronym(value) {
    var raw = String(value === undefined || value === null ? '' : value).trim();
    if (!raw) return '—';
    var canonical = typeof normalizeDepartmentName === 'function'
      ? normalizeDepartmentName(raw)
      : '';
    return DEPARTMENT_ACRONYMS[canonical] || DEPARTMENT_ACRONYMS[raw] || raw;
  }

  /* ── Attendance report ──────────────────────────────────────── */

  function renderAttendanceReport() {
    // On-screen view: summary cards + event list (detailed table is print/CSV only)
    renderAttendanceSummary();
    // Print sections are always generated but hidden on screen
    renderAttendancePrintSections();
  }

  /**
   * Render the summary breakdown table rows for a grouped map of attendance
   * counts. Each row shows the label, total, present, late, and rate.
   *
   * @param {Object} map  program -> {total, present, late}
   * @param {function} labelFn    row key -> display label
   */
  function breakdownRowsHtml(map, labelFn) {
    var keys = Object.keys(map).sort();
    if (!keys.length) {
      return '<tr><td colspan="5" class="text-center text-muted py-4">No data available</td></tr>';
    }
    return keys.map(function (key) {
      var data = map[key];
      var rate = data.total ? Math.round((data.present / data.total) * 100) : 0;
      // The label function is responsible for its own escaping.
      return '<tr>' +
        '<td>' + labelFn(key) + '</td>' +
        '<td class="text-center">' + data.total + '</td>' +
        '<td class="text-center">' + data.present + '</td>' +
        '<td class="text-center">' + data.late + '</td>' +
        '<td class="text-center">' + rate + '%</td>' +
        '</tr>';
    }).join('');
  }

  function renderAttendanceSummary() {
    var summaryContainer = byId('attendanceSummaryView');
    var detailContainer = byId('attendanceDetailView');

    if (!summaryContainer) return;

    var rows = state.rows || [];
    var events = getEvents();

    // Compute summary stats
    var totalRecords = rows.length;
    var totalEvents = events.length;
    var lateRecords = rows.filter(function (row) {
      return String(rowValue(row, 'status', 'present')).toLowerCase() === 'late';
    }).length;
    var presentRecords = rows.filter(function (row) {
      var status = String(rowValue(row, 'status', 'present')).toLowerCase();
      return status === 'present' || status === 'late';
    }).length;
    var attendanceRate = totalRecords ? Math.round((presentRecords / totalRecords) * 100) : 0;

    // Group records by event for the event list
    // Only include events that actually have attendance records
    var eventGroups = {};
    rows.forEach(function (row) {
      var eventId = String(row.eventId || '');
      if (!eventGroups[eventId]) {
        var event = events.find(function (e) { return sameId(e.id, eventId); });
        eventGroups[eventId] = {
          id: eventId,
          name: rowValue(row, 'eventName', 'Unknown event'),
          publicId: rowValue(row, 'eventPublicId', ''),
          date: rowValue(row, 'eventDate', ''),
          startTime: rowValue(row, 'eventStartTime', ''),
          endTime: rowValue(row, 'eventEndTime', ''),
          attendees: 0
        };
      }
      eventGroups[eventId].attendees++;
    });

    var eventListHtml = Object.values(eventGroups).map(function (group) {
      var meta = [];
      if (group.date) meta.push(formatDate(group.date));
      if (group.startTime) {
        meta.push(group.startTime + (group.endTime ? '–' + group.endTime : ''));
      }
      return '<tr>' +
        '<td>' + escapeHtml(group.name) + '</td>' +
        '<td>' + escapeHtml(meta.join(' · ')) + '</td>' +
        '<td class="text-center">' + group.attendees + ' attendee' + (group.attendees === 1 ? '' : 's') + '</td>' +
        '</tr>';
    }).join('');

    if (!eventListHtml) {
      eventListHtml = emptyTableRow(3, 'No attendance records match these filters', 'Adjust the filters and generate the report again.', 'bi-clipboard-x');
    }

    // Attendance by Course / Program breakdown
    var programMap = {};
    rows.forEach(function (row) {
      var program = rowValue(row, 'program', 'Unassigned');
      if (!programMap[program]) {
        programMap[program] = { total: 0, present: 0, late: 0 };
      }
      programMap[program].total++;
      var status = String(rowValue(row, 'status', 'present')).toLowerCase();
      if (status === 'present' || status === 'late') {
        programMap[program].present++;
      }
      if (status === 'late') {
        programMap[program].late++;
      }
    });

    var programRowsHtml = breakdownRowsHtml(programMap, function (program) {
      return escapeHtml(program);
    });

    // Total Events should only count events that have attendance records
    var totalEventsWithRecords = Object.keys(eventGroups).length;

    summaryContainer.innerHTML =
      '<div class="attendance-summary-stats stat-grid" role="group" aria-label="Attendance report summary">' +
        '<article class="stat-card">' +
          '<div class="stat-head"><span class="stat-label">Total Events</span><i class="stat-icon bi bi-calendar-event" aria-hidden="true"></i></div>' +
          '<div class="stat-value">' + totalEventsWithRecords + '</div>' +
          '<div class="stat-foot">With attendance records</div>' +
        '</article>' +
        '<article class="stat-card">' +
          '<div class="stat-head"><span class="stat-label">Total Attendance Records</span><i class="stat-icon bi bi-clipboard-check" aria-hidden="true"></i></div>' +
          '<div class="stat-value">' + totalRecords + '</div>' +
          '<div class="stat-foot">' + lateRecords + ' late' + (lateRecords ? ' · ' : '') + attendanceRate + '% rate</div>' +
        '</article>' +
        '<article class="stat-card">' +
          '<div class="stat-head"><span class="stat-label">Late Records</span><i class="stat-icon bi bi-clock-history" aria-hidden="true"></i></div>' +
          '<div class="stat-value">' + lateRecords + '</div>' +
          '<div class="stat-foot">Flagged for review</div>' +
        '</article>' +
      '</div>' +
      '<div class="table-responsive attendance-summary-wrap">' +
        '<table class="table attendance-summary-table mb-0">' +
          '<caption class="visually-hidden">Summary of events and attendee counts</caption>' +
          '<thead><tr><th scope="col">Event</th><th scope="col">Date & Time</th><th scope="col" class="text-center">Attendees</th></tr></thead>' +
          '<tbody>' + eventListHtml + '</tbody>' +
        '</table>' +
      '</div>' +
      '<section class="attendance-program-breakdown mt-4" aria-labelledby="programBreakdownHeading">' +
        '<h3 id="programBreakdownHeading" class="attendance-dept-heading"><i class="bi bi-book me-2"></i>Attendance by Course / Program</h3>' +
        '<div class="table-responsive">' +
          '<table class="table attendance-dept-table mb-0">' +
            '<caption class="visually-hidden">Attendance breakdown by program</caption>' +
            '<thead><tr><th scope="col">Program</th><th scope="col" class="text-center">Total Records</th><th scope="col" class="text-center">Present</th><th scope="col" class="text-center">Late</th><th scope="col" class="text-center">Rate</th></tr></thead>' +
            '<tbody>' + programRowsHtml + '</tbody>' +
          '</table>' +
        '</div>' +
      '</section>';

    // Hide the detailed table container on screen (it's for print/CSV only)
    if (detailContainer) {
      detailContainer.style.display = 'none';
    }
  }

  /**
   * Group flat attendance rows by event for the print layout. Events are
   * ordered chronologically and attendees alphabetically, so each event
   * reads as its own section rather than one long mixed table.
   */
  function attendanceGroups(rows) {
    var groups = [];
    var index = {};

    (rows || []).forEach(function (row) {
      var key = String(row.eventId || row.eventPublicId || row.eventName || 'unknown');
      if (!index[key]) {
        index[key] = {
          key: key,
          eventId: row.eventId || null,
          eventName: rowValue(row, 'eventName', 'Unknown event'),
          eventPublicId: rowValue(row, 'eventPublicId', ''),
          eventDate: rowValue(row, 'eventDate', rowValue(row, 'date', '')),
          startTime: rowValue(row, 'eventStartTime', ''),
          endTime: rowValue(row, 'eventEndTime', ''),
          category: rowValue(row, 'eventCategory', 'minor'),
          rows: []
        };
        groups.push(index[key]);
      }
      index[key].rows.push(row);
    });

    groups.sort(function (a, b) {
      var left = String(a.eventDate || '') + ' ' + String(a.startTime || '');
      var right = String(b.eventDate || '') + ' ' + String(b.startTime || '');
      return left.localeCompare(right);
    });

    groups.forEach(function (group) {
      group.rows.sort(function (a, b) {
        return String(rowValue(a, 'studentName', '')).localeCompare(String(rowValue(b, 'studentName', '')));
      });
    });

    return groups;
  }

  function renderAttendancePrintSections() {
    var container = byId('attendancePrintSections');
    if (!container) return;

    var rows = state.rows || [];
    var groups = attendanceGroups(rows);
    if (!groups.length) {
      container.innerHTML = '<p class="report-event-empty">No attendance records match these filters.</p>';
      return;
    }

    // Build department breakdown for print
    var deptMap = {};
    rows.forEach(function (row) {
      var dept = rowValue(row, 'department', 'Unassigned');
      if (!deptMap[dept]) {
        deptMap[dept] = { total: 0, present: 0, late: 0 };
      }
      deptMap[dept].total++;
      var status = String(rowValue(row, 'status', 'present')).toLowerCase();
      if (status === 'present' || status === 'late') deptMap[dept].present++;
      if (status === 'late') deptMap[dept].late++;
    });

    var deptRowsHtml = Object.keys(deptMap).sort().map(function (dept) {
      var data = deptMap[dept];
      var rate = data.total ? Math.round((data.present / data.total) * 100) : 0;
      return '<tr>' +
        '<td>' + escapeHtml(departmentAcronym(dept)) + '</td>' +
        '<td>' + escapeHtml(dept) + '</td>' +
        '<td class="text-center">' + data.total + '</td>' +
        '<td class="text-center">' + data.present + '</td>' +
        '<td class="text-center">' + data.late + '</td>' +
        '<td class="text-center">' + rate + '%</td>' +
        '</tr>';
    }).join('');

    // Build program breakdown for print
    var programMap = {};
    rows.forEach(function (row) {
      var program = rowValue(row, 'program', 'Unassigned');
      if (!programMap[program]) {
        programMap[program] = { total: 0, present: 0, late: 0 };
      }
      programMap[program].total++;
      var status = String(rowValue(row, 'status', 'present')).toLowerCase();
      if (status === 'present' || status === 'late') programMap[program].present++;
      if (status === 'late') programMap[program].late++;
    });

    var programRowsHtml = Object.keys(programMap).sort().map(function (program) {
      var data = programMap[program];
      var rate = data.total ? Math.round((data.present / data.total) * 100) : 0;
      return '<tr>' +
        '<td>' + escapeHtml(program) + '</td>' +
        '<td class="text-center">' + data.total + '</td>' +
        '<td class="text-center">' + data.present + '</td>' +
        '<td class="text-center">' + data.late + '</td>' +
        '<td class="text-center">' + rate + '%</td>' +
        '</tr>';
    }).join('');

    // Start with department and program breakdown tables
    var html = '<section class="attendance-print-breakdown">' +
      '<h2 class="attendance-print-breakdown-title"><i class="bi bi-building me-2"></i>Attendance by Department</h2>' +
      '<table class="table table-bordered report-event-table">' +
        '<caption class="visually-hidden">Attendance breakdown by department</caption>' +
        '<thead><tr><th scope="col">Acronym</th><th scope="col">Department</th><th scope="col" class="text-center">Total Records</th><th scope="col" class="text-center">Present</th><th scope="col" class="text-center">Late</th><th scope="col" class="text-center">Rate</th></tr></thead>' +
        '<tbody>' + deptRowsHtml + '</tbody>' +
      '</table>' +
    '</section>' +
    '<section class="attendance-print-breakdown">' +
      '<h2 class="attendance-print-breakdown-title"><i class="bi bi-book me-2"></i>Attendance by Course / Program</h2>' +
      '<table class="table table-bordered report-event-table">' +
        '<caption class="visually-hidden">Attendance breakdown by program</caption>' +
        '<thead><tr><th scope="col">Program</th><th scope="col" class="text-center">Total Records</th><th scope="col" class="text-center">Present</th><th scope="col" class="text-center">Late</th><th scope="col" class="text-center">Rate</th></tr></thead>' +
        '<tbody>' + programRowsHtml + '</tbody>' +
      '</table>' +
    '</section>';

    // Add event sections
    html += groups.map(function (group) {
      var meta = [];
      if (group.eventDate) meta.push(formatDate(group.eventDate));
      if (group.startTime) {
        meta.push(group.startTime + (group.endTime ? '–' + group.endTime : ''));
      }
      meta.push(group.rows.length + ' attendee' + (group.rows.length === 1 ? '' : 's'));

      var rows = group.rows.map(function (row, index) {
        var status = String(rowValue(row, 'status', 'present')).toLowerCase();
        var statusLabel = rowValue(row, 'statusLabel', status === 'late' ? 'Late' : 'Present');
        var badge = status === 'late' ? 'bg-warning text-dark' : 'bg-success';
        var year = row.yearLevel ? getStudentYearLabel(row.yearLevel) : '—';
        return '<tr>' +
          '<td>' + (index + 1) + '</td>' +
          '<td>' + escapeHtml(rowValue(row, 'studentName', 'Unknown student')) + '</td>' +
          '<td>' + escapeHtml(rowValue(row, 'studentIdNumber', rowValue(row, 'studentPublicId', '—'))) + '</td>' +
          '<td>' + escapeHtml(departmentAcronym(rowValue(row, 'department', 'Unassigned'))) + '</td>' +
          '<td>' + escapeHtml(rowValue(row, 'program', 'Unassigned')) + '</td>' +
          '<td>' + escapeHtml(year) + '</td>' +
          '<td>' + escapeHtml(rowValue(row, 'time', '—')) + '</td>' +
          '<td>' + escapeHtml(rowValue(row, 'checkOutTimeLabel', '—')) + '</td>' +
          '<td><span class="badge ' + badge + '">' + escapeHtml(statusLabel) + '</span></td>' +
          '</tr>';
      }).join('');

      return '<section class="report-event-section">' +
        '<header class="report-event-header">' +
          '<div class="report-event-title">' +
            '<h3>' + escapeHtml(group.eventName) + '</h3>' +
            (group.eventPublicId ? '<span class="report-event-id">' + escapeHtml(group.eventPublicId) + '</span>' : '') +
          '</div>' +
          '<p class="report-event-meta">' + escapeHtml(meta.join(' · ')) + '</p>' +
        '</header>' +
        '<table class="table table-bordered report-event-table">' +
          '<caption class="visually-hidden">Attendance for ' + escapeHtml(group.eventName) + '</caption>' +
          '<thead><tr>' +
            '<th scope="col">#</th>' +
            '<th scope="col">Student</th>' +
            '<th scope="col">Student ID</th>' +
            '<th scope="col">Department</th>' +
            '<th scope="col">Program</th>' +
            '<th scope="col">Year Level</th>' +
            '<th scope="col">Time In</th>' +
            '<th scope="col">Time Out</th>' +
            '<th scope="col">Status</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</section>';
    }).join('');
  }

  function updateSummary() {
    var total = byId('reportTotalRecords');
    var rate = byId('reportAttendanceRate');
    var progress = byId('reportProgressAttendance');
    var events = byId('reportTotalEvents');
    var sanctions = byId('reportActiveSanctions');

    if (total) total.textContent = state.rows.length;
    if (rate) {
      var attended = state.rows.filter(function (row) {
        return row.status === 'present' || row.status === 'late';
      }).length;
      var percentage = state.rows.length ? Math.round((attended / state.rows.length) * 100) : 0;
      rate.textContent = percentage + '%';
      if (progress) progress.style.width = percentage + '%';
    }
    if (events) events.textContent = getEvents().length;
    if (sanctions) {
      sanctions.textContent = '0';
    }
  }

  function filterSummary(filters) {
    var event = filters.eventId
      ? getEvents().find(function (item) { return sameId(item.id, filters.eventId); })
      : null;
    var eventLabel = event
      ? (event.publicId ? event.publicId + ' · ' : '') + event.name
      : '';
    var parts = [];
    if (filters.program) parts.push(filters.program);
    if (filters.yearLevel) parts.push(getStudentYearLabel(filters.yearLevel));
    if (filters.department) parts.push(departmentAcronym(filters.department));
    if (eventLabel) parts.push(eventLabel);
    return parts.length ? parts.join(' · ') : 'All attendance records';
  }

  function updatePrintMeta() {
    var filters = state.filters || readFilters();
    var summary = byId('reportPrintFilters');
    var generated = byId('reportPrintGenerated');
    var note = byId('reportGeneratedNote');
    var generatedAt = state.generatedAt || new Date();
    var groups = attendanceGroups(state.rows);

    if (summary) summary.textContent = 'Report: ' + filterSummary(filters);
    if (generated) generated.textContent = generatedAt.toLocaleString();
    if (note) {
      note.textContent = state.rows.length + ' record' + (state.rows.length === 1 ? '' : 's') +
        ' across ' + groups.length + ' event' + (groups.length === 1 ? '' : 's') +
        ' generated ' + generatedAt.toLocaleString() + '.';
    }
  }

  async function generateAttendanceReport() {
    var tbody = byId('attendanceReportBody');
    if (!tbody) return;

    var button = byId('generateReportBtn');
    state.filters = readFilters();
    tbody.innerHTML = '<tr><td colspan="11" class="text-center text-muted py-4">Loading report…</td></tr>';
    if (button) button.disabled = true;

    try {
      var rows = (typeof isApiEnabled === 'function' && isApiEnabled())
        ? await api.attendanceReport(state.filters)
        : localAttendanceReport(state.filters);
      state.rows = Array.isArray(rows) ? rows : [];
      state.generatedAt = new Date();
      renderAttendanceReport();
      updateSummary();
      updatePrintMeta();
    } catch (error) {
      console.error('Attendance report failed:', error);
      state.rows = [];
      tbody.innerHTML = '<tr><td colspan="11" class="text-center text-danger py-4">' +
        escapeHtml(error.message || 'Could not generate the report.') + '</td></tr>';
      renderAttendancePrintSections();
      showToast('error', error.message || 'Could not generate the report.');
    } finally {
      if (button) button.disabled = false;
    }
  }

  /* ── Semester sanction matrix ───────────────────────────────── */

  function mandatoryEventEnd(event) {
    var date = event.date || event.eventDate;
    var start = event.startTime || event.start_time || event.time || '00:00';
    var end = event.endTime || event.end_time;
    if (!date || !end) return null;
    var startDate = new Date(date + 'T' + start);
    var endDate = new Date(date + 'T' + end);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return null;
    if (endDate <= startDate) endDate.setDate(endDate.getDate() + 1);
    return endDate;
  }

  function attendanceFlags(record) {
    if (!record) return null;
    var checkIn = timestampLabel(record.time) ||
      timestampLabel(record.checkInTimeLabel) ||
      timestampLabel(record.checkInTime);
    var checkOut = checkOutLabel(record);
    var inHour = checkIn ? parseInt(checkIn.slice(0, 2), 10) : null;
    var outHour = checkOut ? parseInt(checkOut.slice(0, 2), 10) : null;
    return {
      attended: true,
      amIn: inHour !== null && inHour < 12,
      amOut: outHour !== null && outHour < 12,
      pmIn: inHour !== null && inHour >= 12,
      pmOut: outHour !== null && outHour >= 12,
      checkIn: checkIn || null,
      checkOut: checkOut || null
    };
  }

  function localSanctionMatrix(filters) {
    var eventIds = Array.isArray(filters.eventIds)
      ? filters.eventIds.map(String).filter(Boolean)
      : [];
    if (!eventIds.length && filters.eventId) eventIds = [String(filters.eventId)];
    var from = filters.from || '';
    var to = filters.to || '';
    var semester = filters.semester || '';
    var now = new Date();
    var events = getEvents().filter(function (event) {
      if (!event || event.status === 'cancelled') return false;
      if (eventIds.length && eventIds.indexOf(String(event.id)) === -1) return false;
      var date = String(event.date || event.eventDate || '');
      if (from && date < from) return false;
      if (to && date > to) return false;
      if (semester && event.semester !== semester) return false;
      return true;
    }).sort(function (a, b) {
      return (String(a.date || '') + ' ' + String(a.startTime || a.time || ''))
        .localeCompare(String(b.date || '') + ' ' + String(b.startTime || b.time || ''));
    });

    var endedMandatory = events.filter(function (event) {
      if (!isMandatoryEvent(event)) return false;
      var end = mandatoryEventEnd(event);
      return end !== null && end < now;
    });
    var attendance = getAttendance();

    var rows = getUsers().filter(function (user) {
      return String(user.role) === 'student';
    }).map(function (user) {
      var flags = {};
      events.forEach(function (event) {
        var record = attendance.find(function (item) {
          return sameId(item.eventId, event.id) && sameId(item.studentId, user.id);
        });
        if (record) flags[String(event.id)] = attendanceFlags(record);
      });

      var absences = endedMandatory.filter(function (event) {
        return !flags[String(event.id)];
      }).length;

      return {
        studentId: user.id,
        studentPublicId: user.publicId || user.studentIdNumber || null,
        studentIdNumber: user.studentIdNumber || null,
        studentName: user.name || 'Unknown student',
        department: user.department || 'Unassigned',
        program: user.program || user.course || 'Unassigned',
        yearLevel: user.yearLevel || null,
        block: user.block || null,
        totalAbsences: absences,
        forSanction: absences > 3,
        attendance: flags,
      };
    });

    rows.sort(function (a, b) {
      if (b.totalAbsences !== a.totalAbsences) return b.totalAbsences - a.totalAbsences;
      return String(a.studentName).localeCompare(String(b.studentName));
    });

    return {
      range: {
        from: from || null,
        to: to || null,
        eventIds: eventIds,
        eventId: eventIds.length === 1 ? eventIds[0] : null
      },
      events: events.map(function (event) {
        return {
          id: event.id,
          publicId: event.publicId || null,
          name: event.name || 'Unknown event',
          date: event.date || event.eventDate || null,
          startTime: event.startTime || event.time || null,
          endTime: event.endTime || null,
          category: eventCategory(event),
          mandatory: isMandatoryEvent(event),
          status: event.status || 'scheduled'
        };
      }),
      students: rows
    };
  }

  function filteredSanctionRows() {
    return state.sanctionRows;
  }

  /**
   * Screen preview only: the full matrix is deliberately kept out of the
   * on-screen flow and rendered for print/CSV instead. These cards and the
   * four-column table give the presenter a readable summary.
   */
  function renderSanctionSummary(events, rows) {
    var totalStudents = byId('sanctionTotalStudents');
    var studentsWithSanctions = byId('sanctionStudentsWithSanctions');
    var totalAbsences = byId('sanctionTotalAbsences');
    var tbody = byId('sanctionSummaryBody');

    // Cards describe the whole date-range roster; the table below them is
    // the status-filtered preview, so Total Students stays stable when the
    // status dropdown changes.
    var allRows = state.sanctionRows || [];
    var sanctioned = allRows.filter(function (row) {
      return row.forSanction === true;
    }).length;
    var absences = allRows.reduce(function (sum, row) {
      return sum + Number(row.totalAbsences || 0);
    }, 0);

    if (totalStudents) totalStudents.textContent = allRows.length;
    if (studentsWithSanctions) studentsWithSanctions.textContent = sanctioned;
    if (totalAbsences) totalAbsences.textContent = absences;
    if (!tbody) return;

    if (!events.length) {
      tbody.innerHTML = emptyTableRow(4, 'No events match this filter', 'Choose another event or switch to the semester view.', 'bi-calendar-x');
      return;
    }

    if (!rows.length) {
      tbody.innerHTML = emptyTableRow(4, 'No students match this filter', 'Try a different event or semester.', 'bi-people');
      return;
    }

    tbody.innerHTML = rows.map(function (row) {
      var id = row.studentIdNumber || row.studentPublicId || '—';
      var absencesValue = Number(row.totalAbsences || 0);
      var forSanction = row.forSanction === true;
      return '<tr>' +
        '<td class="sanction-summary-id">' + escapeHtml(id) + '</td>' +
        '<td class="sanction-summary-name">' + escapeHtml(row.studentName || 'Unknown student') + '</td>' +
        '<td class="sanction-summary-absences' + (absencesValue ? '' : ' is-zero') + '">' +
          absencesValue + (forSanction ? ' <span class="badge bg-danger ms-2">SANCTIONED</span>' : '') + '</td>' +
        '<td class="sanction-summary-for-sanction">' + (forSanction ? '<span class="badge bg-danger">YES</span>' : '<span class="badge bg-success">NO</span>') + '</td>' +
        '</tr>';
    }).join('');
  }

  function eventHeadLabel(event) {
    var meta = [];
    if (event.publicId) meta.push(event.publicId);
    if (event.date) meta.push(formatDate(event.date));
    return '<span class="matrix-event-name">' + escapeHtml(event.name || 'Untitled event') + '</span>' +
      (meta.length ? '<small class="matrix-event-meta">' + escapeHtml(meta.join(' · ')) + '</small>' : '');
  }

  function matrixHeadHtml(events, rowSpan) {
    var html = '<tr>' +
      '<th scope="col" rowspan="' + rowSpan + '" class="matrix-student-id">Student ID</th>' +
      '<th scope="col" rowspan="' + rowSpan + '" class="matrix-student-name">Name</th>';

    events.forEach(function (event) {
      if (isMajorEvent(event)) {
        html += '<th scope="colgroup" colspan="4" class="matrix-major-head">' +
          eventHeadLabel(event) + '</th>';
      } else {
        html += '<th scope="col" rowspan="' + rowSpan + '" class="matrix-minor-head">' +
          eventHeadLabel(event) + '</th>';
      }
    });

    html += '<th scope="col" rowspan="' + rowSpan + '" class="matrix-absences">Total Absences</th>' +
      '<th scope="col" rowspan="' + rowSpan + '" class="matrix-for-sanction">For Sanction</th>' +
      '</tr>';

    if (rowSpan === 2) {
      html += '<tr>';
      events.forEach(function (event) {
        if (!isMajorEvent(event)) return;
        ['AM In', 'AM Out', 'PM In', 'PM Out'].forEach(function (label) {
          html += '<th scope="col" class="matrix-subhead">' + label + '</th>';
        });
      });
      html += '</tr>';
    }

    return html;
  }

  function matrixCheckCell(present) {
    return '<td class="matrix-check' + (present ? ' is-present' : '') + '" aria-label="' +
      (present ? 'Attended' : 'No attendance') + '">' + (present ? '✓' : '') + '</td>';
  }

  function matrixColumnCount(events) {
    return 2 + events.reduce(function (total, event) {
      return total + (isMajorEvent(event) ? 4 : 1);
    }, 0) + 2;
  }

  function matrixRowsHtml(events, rows) {
    return rows.map(function (row) {
      var attendance = row.attendance || {};
      var id = row.studentIdNumber || row.studentPublicId || '—';
      var meta = [];
      if (row.studentPublicId && row.studentIdNumber) meta.push(row.studentPublicId);
      if (row.department) meta.push(departmentAcronym(row.department));

      var html = '<tr>' +
        '<th scope="row" class="matrix-student-id">' + escapeHtml(id) + '</th>' +
        '<td class="matrix-student-name">' +
          '<span class="matrix-name">' + escapeHtml(row.studentName || 'Unknown student') + '</span>' +
          (meta.length ? '<small class="matrix-student-meta">' + escapeHtml(meta.join(' · ')) + '</small>' : '') +
        '</td>';

      events.forEach(function (event) {
        var mark = attendance[String(event.id)] || null;
        if (isMajorEvent(event)) {
          html += matrixCheckCell(!!(mark && mark.amIn));
          html += matrixCheckCell(!!(mark && mark.amOut));
          html += matrixCheckCell(!!(mark && mark.pmIn));
          html += matrixCheckCell(!!(mark && mark.pmOut));
        } else {
          html += matrixCheckCell(!!(mark && mark.attended));
        }
      });

      var forSanction = row.forSanction === true;
      var absencesValue = Number(row.totalAbsences || 0);
      html += '<td class="matrix-absences">' + absencesValue + (forSanction ? ' <span class="badge bg-danger">SANCTIONED</span>' : '') + '</td>' +
        '<td class="matrix-for-sanction">' + (forSanction ? '<span class="badge bg-danger">YES</span>' : '<span class="badge bg-success">NO</span>') + '</td>' +
        '</tr>';
      return html;
    }).join('');
  }

  function renderSanctionReport() {
    var head = byId('sanctionMatrixHead');
    var tbody = byId('sanctionReportBody');
    var events = state.sanctionEvents || [];
    var rows = filteredSanctionRows();

    renderSanctionSummary(events, rows);

    if (!theadOrBody(head, tbody)) return;

    if (!events.length) {
      head.innerHTML = '';
      tbody.innerHTML = emptyTableRow(4, 'No events match this filter', 'Choose another event or switch to the semester view.', 'bi-calendar-x');
      updateSanctionPrintMeta();
      return;
    }

    var hasMajor = events.some(isMajorEvent);
    var rowSpan = hasMajor ? 2 : 1;
    var columnCount = matrixColumnCount(events);
    head.innerHTML = matrixHeadHtml(events, rowSpan);

    if (!rows.length) {
      var message = state.sanctionRows.length
        ? 'No students match this filter.'
        : 'No students are enrolled for this filter.';
      tbody.innerHTML = '<tr><td colspan="' + columnCount + '" class="role-empty-cell">' +
        '<i class="bi bi-people" aria-hidden="true"></i>' +
        '<strong>' + escapeHtml(message) + '</strong>' +
        '<span>Try a different event or semester.</span></td></tr>';
      updateSanctionPrintMeta();
      return;
    }

    tbody.innerHTML = matrixRowsHtml(events, rows);
    updateSanctionPrintMeta();
  }

  function theadOrBody(head, body) {
    return !!(head && body);
  }

  async function loadSanctionReport() {
    var tbody = byId('sanctionReportBody');
    var head = byId('sanctionMatrixHead');
    if (!tbody) return;

    var filters = readSanctionFilters();
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">Loading matrix…</td></tr>';
    var summaryBody = byId('sanctionSummaryBody');
    if (summaryBody) {
      summaryBody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">Loading summary…</td></tr>';
    }
    if (head) head.innerHTML = '';

    try {
      var data = (typeof isApiEnabled === 'function' && isApiEnabled())
        ? await api.sanctionsReport(filters)
        : localSanctionMatrix(filters);

      if (Array.isArray(data)) {
        // Defensive: tolerate an older API that returned only student rows.
        state.sanctionEvents = [];
        state.sanctionRows = data;
        state.sanctionRange = filters;
      } else {
        state.sanctionEvents = Array.isArray(data.events) ? data.events : [];
        state.sanctionRows = Array.isArray(data.students) ? data.students : [];
        state.sanctionRange = data.range || filters;
      }
      state.sanctionGeneratedAt = new Date();
      renderSanctionReport();
    } catch (error) {
      console.error('Sanction report failed:', error);
      state.sanctionEvents = [];
      state.sanctionRows = [];
      state.sanctionGeneratedAt = new Date();
      renderSanctionSummary([], []);
      var summaryErrorBody = byId('sanctionSummaryBody');
      if (summaryErrorBody) {
        summaryErrorBody.innerHTML = '<tr><td colspan="4" class="text-center text-danger py-4">' +
          escapeHtml(error.message || 'Could not generate the sanction report.') + '</td></tr>';
      }
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-danger py-4">' +
        escapeHtml(error.message || 'Could not generate the sanction report.') + '</td></tr>';
      updateSanctionPrintMeta();
      showToast('error', error.message || 'Could not generate the sanction report.');
    }
  }

  function sanctionEventLabel(eventId) {
    if (!eventId) return 'All events';
    var events = (state.sanctionEvents || []).concat(getEvents());
    var event = events.find(function (item) { return item && sameId(item.id, eventId); });
    if (event) {
      return (event.publicId ? event.publicId + ' - ' : '') + (event.name || 'Selected event');
    }
    var select = byId('filterEvent');
    var option = select && select.selectedOptions && select.selectedOptions[0];
    return option && option.value ? option.textContent : 'Selected event';
  }

  function sanctionRangeLabel(range) {
    var eventIds = range && Array.isArray(range.eventIds)
      ? range.eventIds.map(String).filter(Boolean)
      : [];
    if (!eventIds.length && range && range.eventId) eventIds = [String(range.eventId)];
    if (eventIds.length === 1) return sanctionEventLabel(eventIds[0]);
    if (eventIds.length > 1) return eventIds.length + ' events selected';
    var from = range && range.from ? range.from : '';
    var to = range && range.to ? range.to : '';
    if (from && to) return formatDate(from) + ' – ' + formatDate(to);
    if (from) return 'From ' + formatDate(from);
    if (to) return 'Until ' + formatDate(to);
    return 'All events';
  }

  function updateSanctionPrintMeta() {
    var summary = byId('sanctionPrintFilters');
    var generated = byId('sanctionPrintGenerated');
    var note = byId('sanctionReportGeneratedNote');
    var generatedAt = state.sanctionGeneratedAt || new Date();
    var rows = filteredSanctionRows();
    var events = state.sanctionEvents || [];
    var majorCount = events.filter(isMajorEvent).length;
    var absences = rows.reduce(function (sum, row) {
      return sum + Number(row.totalAbsences || 0);
    }, 0);
    var select = byId('sanctionStatusFilter');
    var statusLabel = select && select.selectedIndex >= 0
      ? select.options[select.selectedIndex].text
      : 'All statuses';
    var range = state.sanctionRange || readSanctionFilters();
    var scope = [];
    if (range && range.department) scope.push(range.department);
    if (range && range.program) scope.push(programLabel(range.program));

    if (summary) {
      summary.textContent = 'Report: Semester matrix · ' + sanctionRangeLabel(range) +
        (scope.length ? ' · ' + scope.join(' · ') : '') +
        ' · ' + statusLabel +
        ' · ' + events.length + ' event' + (events.length === 1 ? '' : 's') +
        ' (' + majorCount + ' major)';
    }
    if (generated) generated.textContent = generatedAt.toLocaleString();
    if (note) {
      note.textContent = rows.length + ' student' + (rows.length === 1 ? '' : 's') +
        ' · ' + absences + ' total absence' + (absences === 1 ? '' : 's') +
        ' · ' + events.length + ' event column' + (events.length === 1 ? '' : 's') +
        ' generated ' + generatedAt.toLocaleString() + '.';
    }
  }

  function populateSanctionEventSelect() {
    var select = byId('filterEvent');
    if (!select) return;
    var selected = selectedEventIds();
    var options = getEvents().slice().sort(function (a, b) {
      return (String(a.date || '') + ' ' + String(a.startTime || a.time || ''))
        .localeCompare(String(b.date || '') + ' ' + String(b.startTime || b.time || ''));
    }).map(function (event) {
      return {
        value: event.id != null ? String(event.id) : '',
        label: (event.publicId ? event.publicId + ' - ' : '') + (event.name || 'Untitled event')
      };
    }).filter(function (option) { return option.value !== ''; });

    select.innerHTML = options.length
      ? options.map(function (option) {
          return '<option value="' + escapeHtml(option.value) + '">' + escapeHtml(option.label) + '</option>';
        }).join('')
      : '<option value="" disabled>No events available</option>';

    Array.prototype.forEach.call(select.options, function (option) {
      option.selected = selected.indexOf(option.value) !== -1;
    });
  }

  /* ── CSV ────────────────────────────────────────────────────── */

  function csvCell(value) {
    return '"' + String(value === undefined || value === null ? '' : value).replace(/"/g, '""') + '"';
  }

  function downloadCsv(filename, headers, rows) {
    var lines = [headers.map(csvCell).join(',')];
    rows.forEach(function (row) {
      lines.push(row.map(csvCell).join(','));
    });

    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    var headers = ['Student', 'Student ID', 'Department', 'Program', 'Year Level', 'Block', 'Event', 'Date', 'Check-in', 'Check-out', 'Status'];
    var rows = state.rows.map(function (row) {
      return [
        rowValue(row, 'studentName', ''),
        rowValue(row, 'studentIdNumber', rowValue(row, 'studentPublicId', '')),
        departmentAcronym(rowValue(row, 'department', '')),
        rowValue(row, 'program', ''),
        row.yearLevel ? getStudentYearLabel(row.yearLevel) : '',
        rowValue(row, 'block', ''),
        rowValue(row, 'eventName', ''),
        rowValue(row, 'date', rowValue(row, 'eventDate', '')),
        rowValue(row, 'time', ''),
        rowValue(row, 'checkOutTimeLabel', ''),
        rowValue(row, 'statusLabel', '')
      ];
    });

    // Build department breakdown
    var deptMap = {};
    state.rows.forEach(function (row) {
      var dept = rowValue(row, 'department', 'Unassigned');
      if (!deptMap[dept]) {
        deptMap[dept] = { total: 0, present: 0, late: 0 };
      }
      deptMap[dept].total++;
      var status = String(rowValue(row, 'status', 'present')).toLowerCase();
      if (status === 'present' || status === 'late') deptMap[dept].present++;
      if (status === 'late') deptMap[dept].late++;
    });

    var deptHeaders = ['Acronym', 'Department', 'Total Records', 'Present', 'Late', 'Rate (%)'];
    var deptRows = Object.keys(deptMap).sort().map(function (dept) {
      var data = deptMap[dept];
      var rate = data.total ? Math.round((data.present / data.total) * 100) : 0;
      return [
        departmentAcronym(dept),
        dept,
        data.total,
        data.present,
        data.late,
        rate
      ];
    });

    // Build program breakdown
    var programMap = {};
    state.rows.forEach(function (row) {
      var program = rowValue(row, 'program', 'Unassigned');
      if (!programMap[program]) {
        programMap[program] = { total: 0, present: 0, late: 0 };
      }
      programMap[program].total++;
      var status = String(rowValue(row, 'status', 'present')).toLowerCase();
      if (status === 'present' || status === 'late') programMap[program].present++;
      if (status === 'late') programMap[program].late++;
    });

    var programHeaders = ['Program', 'Total Records', 'Present', 'Late', 'Rate (%)'];
    var programRows = Object.keys(programMap).sort().map(function (program) {
      var data = programMap[program];
      var rate = data.total ? Math.round((data.present / data.total) * 100) : 0;
      return [program, data.total, data.present, data.late, rate];
    });

    // Combine all sections into one CSV with section separators
    var allLines = [];
    allLines.push(headers.map(csvCell).join(','));
    rows.forEach(function (r) { allLines.push(r.map(csvCell).join(',')); });
    allLines.push(''); // empty row separator
    allLines.push(['=== Attendance by Department ==='].map(csvCell).join(','));
    allLines.push(deptHeaders.map(csvCell).join(','));
    deptRows.forEach(function (r) { allLines.push(r.map(csvCell).join(',')); });
    allLines.push(''); // empty row separator
    allLines.push(['=== Attendance by Course/Program ==='].map(csvCell).join(','));
    allLines.push(programHeaders.map(csvCell).join(','));
    programRows.forEach(function (r) { allLines.push(r.map(csvCell).join(',')); });

    var blob = new Blob([allLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'attendance-report.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('success', 'Attendance report exported.');
  }

  function exportExcel() {
    if (typeof XLSX === 'undefined') {
      showToast('error', 'SheetJS library not loaded. Cannot export Excel.');
      return;
    }

    // Sheet 1: Attendance Records
    var headers = ['Student', 'Student ID', 'Department', 'Program', 'Year Level', 'Block', 'Event', 'Date', 'Check-in', 'Check-out', 'Status'];
    var dataRows = state.rows.map(function (row) {
      return [
        rowValue(row, 'studentName', ''),
        rowValue(row, 'studentIdNumber', rowValue(row, 'studentPublicId', '')),
        departmentAcronym(rowValue(row, 'department', '')),
        rowValue(row, 'program', ''),
        row.yearLevel ? getStudentYearLabel(row.yearLevel) : '',
        rowValue(row, 'block', ''),
        rowValue(row, 'eventName', ''),
        rowValue(row, 'date', rowValue(row, 'eventDate', '')),
        rowValue(row, 'time', ''),
        rowValue(row, 'checkOutTimeLabel', ''),
        rowValue(row, 'statusLabel', '')
      ];
    });
    var sheet1Data = [headers].concat(dataRows);

    // Sheet 2: Attendance by Department
    var deptMap = {};
    state.rows.forEach(function (row) {
      var dept = rowValue(row, 'department', 'Unassigned');
      if (!deptMap[dept]) {
        deptMap[dept] = { total: 0, present: 0, late: 0 };
      }
      deptMap[dept].total++;
      var status = String(rowValue(row, 'status', 'present')).toLowerCase();
      if (status === 'present' || status === 'late') deptMap[dept].present++;
      if (status === 'late') deptMap[dept].late++;
    });

    var deptHeaders = ['Acronym', 'Department', 'Total Records', 'Present', 'Late', 'Rate (%)'];
    var deptRows = Object.keys(deptMap).sort().map(function (dept) {
      var data = deptMap[dept];
      var rate = data.total ? Math.round((data.present / data.total) * 100) : 0;
      return [
        departmentAcronym(dept),
        dept,
        data.total,
        data.present,
        data.late,
        rate
      ];
    });
    var sheet2Data = [deptHeaders].concat(deptRows);

    // Sheet 3: Attendance by Course/Program
    var programMap = {};
    state.rows.forEach(function (row) {
      var program = rowValue(row, 'program', 'Unassigned');
      if (!programMap[program]) {
        programMap[program] = { total: 0, present: 0, late: 0 };
      }
      programMap[program].total++;
      var status = String(rowValue(row, 'status', 'present')).toLowerCase();
      if (status === 'present' || status === 'late') programMap[program].present++;
      if (status === 'late') programMap[program].late++;
    });

    var programHeaders = ['Program', 'Total Records', 'Present', 'Late', 'Rate (%)'];
    var programRows = Object.keys(programMap).sort().map(function (program) {
      var data = programMap[program];
      var rate = data.total ? Math.round((data.present / data.total) * 100) : 0;
      return [program, data.total, data.present, data.late, rate];
    });
    var sheet3Data = [programHeaders].concat(programRows);

    // Create workbook with multiple sheets
    var wb = XLSX.utils.book_new();
    var ws1 = XLSX.utils.aoa_to_sheet(sheet1Data);
    var ws2 = XLSX.utils.aoa_to_sheet(sheet2Data);
    var ws3 = XLSX.utils.aoa_to_sheet(sheet3Data);
    XLSX.utils.book_append_sheet(wb, ws1, 'Attendance Records');
    XLSX.utils.book_append_sheet(wb, ws2, 'By Department');
    XLSX.utils.book_append_sheet(wb, ws3, 'By Program');

    // Write and download
    var wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    var blob = new Blob([wbout], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'attendance-report.xlsx';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('success', 'Attendance report exported to Excel.');
  }

  function exportSanctionCsv() {
    var events = state.sanctionEvents || [];
    var headers = ['Student ID', 'Name', 'Block'];

    events.forEach(function (event) {
      var name = event.name || 'Event';
      if (isMajorEvent(event)) {
        ['AM In', 'AM Out', 'PM In', 'PM Out'].forEach(function (label) {
          headers.push(name + ' — ' + label);
        });
      } else {
        headers.push(name);
      }
    });

    headers.push('Total Absences', 'For Sanction');

    var rows = filteredSanctionRows().map(function (row) {
      var attendance = row.attendance || {};
      var values = [
        row.studentIdNumber || row.studentPublicId || '',
        row.studentName || '',
        row.block || ''
      ];

      events.forEach(function (event) {
        var mark = attendance[String(event.id)] || null;
        if (isMajorEvent(event)) {
          values.push(mark && mark.amIn ? '✓' : '');
          values.push(mark && mark.amOut ? '✓' : '');
          values.push(mark && mark.pmIn ? '✓' : '');
          values.push(mark && mark.pmOut ? '✓' : '');
        } else {
          values.push(mark && mark.attended ? '✓' : '');
        }
      });

      var forSanction = row.forSanction === true;
      values.push(Number(row.totalAbsences || 0));
      values.push(forSanction ? 'YES' : 'NO');
      return values;
    });

    downloadCsv('sanction-semester-matrix.csv', headers, rows);
    showToast('success', 'Full semester matrix exported.');
  }

  function exportSanctionExcel() {
    if (typeof XLSX === 'undefined') {
      showToast('error', 'SheetJS library not loaded. Cannot export Excel.');
      return;
    }

    var events = state.sanctionEvents || [];
    var headers = ['Student ID', 'Name', 'Block'];

    events.forEach(function (event) {
      var name = event.name || 'Event';
      if (isMajorEvent(event)) {
        ['AM In', 'AM Out', 'PM In', 'PM Out'].forEach(function (label) {
          headers.push(name + ' — ' + label);
        });
      } else {
        headers.push(name);
      }
    });

    headers.push('Total Absences', 'For Sanction');

    var dataRows = filteredSanctionRows().map(function (row) {
      var attendance = row.attendance || {};
      var values = [
        row.studentIdNumber || row.studentPublicId || '',
        row.studentName || '',
        row.block || ''
      ];

      events.forEach(function (event) {
        var mark = attendance[String(event.id)] || null;
        if (isMajorEvent(event)) {
          values.push(mark && mark.amIn ? '✓' : '');
          values.push(mark && mark.amOut ? '✓' : '');
          values.push(mark && mark.pmIn ? '✓' : '');
          values.push(mark && mark.pmOut ? '✓' : '');
        } else {
          values.push(mark && mark.attended ? '✓' : '');
        }
      });

      var forSanction = row.forSanction === true;
      values.push(Number(row.totalAbsences || 0));
      values.push(forSanction ? 'YES' : 'NO');
      return values;
    });

    var sheetData = [headers].concat(dataRows);

    // Create workbook
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(sheetData);
    XLSX.utils.book_append_sheet(wb, ws, 'Sanction Matrix');

    // Write and download
    var wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    var blob = new Blob([wbout], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'sanction-semester-matrix.xlsx';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('success', 'Sanction matrix exported to Excel.');
  }

  /* ── Wiring ─────────────────────────────────────────────────── */

  function showTab(tabId) {
    var trigger = byId(tabId) || document.querySelector('#reportTabs .nav-link');
    if (window.bootstrap && trigger) {
      try {
        window.bootstrap.Tab.getOrCreateInstance(trigger).show();
      } catch (error) {
        // Printing still works if the tab plugin is unavailable.
      }
    }
  }

  function setSanctionMatrixPrintVisible(visible) {
    var matrix = byId('sanctionMatrixView');
    if (matrix) matrix.classList.toggle('is-print-visible', !!visible);
  }

  function printReport() {
    updatePrintMeta();
    showTab('attendanceTab');
    // Fire after the next paint so the printer captures the fully painted
    // DOM instead of a stale frame. Two rAFs guarantee the first frame has
    // been composited before we invoke the print path.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.print();
      });
    });
  }

  function printSanctionReport() {
    updateSanctionPrintMeta();
    showTab('sanctionTab');

    var cleanup = function () {
      setSanctionMatrixPrintVisible(false);
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);

    window.setTimeout(function () {
      // Reveal the hidden matrix only for the print capture, then restore
      // the clean summary view when the dialog closes. The print stylesheet
      // also forces it visible, so Ctrl+P follows the same path.
      setSanctionMatrixPrintVisible(true);
      try {
        window.print();
      } finally {
        window.setTimeout(cleanup, 800);
      }
    }, 180);
  }

  async function refreshEvents() {
    if (typeof isApiEnabled !== 'function' || !isApiEnabled()) return;
    try {
      var events = await api.listEvents();
      if (Array.isArray(events)) setEvents(events);
    } catch (error) {
      console.error('Could not refresh report events:', error);
      // The cached event list is still usable; the report itself will
      // surface a server error if the backend is unavailable.
    }
  }

  async function init() {
    if (initialized) return;
    initialized = true;

    // Pull the latest events from the backend into the shared localStorage
    // cache before any select reads it. The sanction event listbox and the
    // attendance report's event select both consume the same cache, so one
    // refresh is enough.
    await refreshEvents();

    var department = byId('reportDepartment');
    if (department) {
      department.addEventListener('change', populateProgramSelect);
    }

    var generate = byId('generateReportBtn');
    if (generate) generate.addEventListener('click', generateAttendanceReport);

    var print = byId('printReportBtn');
    if (print) print.addEventListener('click', printReport);

    var exportButton = byId('exportExcelBtn');
    if (exportButton) exportButton.addEventListener('click', exportExcel);

    var sanctionSemesterFilter = byId('sanctionSemesterFilter');
    if (sanctionSemesterFilter) sanctionSemesterFilter.addEventListener('change', loadSanctionReport);

    var sanctionDepartment = byId('sanctionDepartmentFilter');
    if (sanctionDepartment) {
      sanctionDepartment.addEventListener('change', function () {
        populateSanctionProgramSelect();
        loadSanctionReport();
      });
    }

    var sanctionProgram = byId('sanctionProgramFilter');
    if (sanctionProgram) sanctionProgram.addEventListener('change', loadSanctionReport);

    var sanctionEvent = byId('filterEvent');
    if (sanctionEvent) sanctionEvent.addEventListener('change', loadSanctionReport);

    var clearSanctionEvents = byId('filterEventClear');
    if (clearSanctionEvents) {
      clearSanctionEvents.addEventListener('click', function () {
        // "Clear filters" resets the whole bar, not just the event listbox.
        ['filterEvent', 'sanctionSemesterFilter', 'sanctionDepartmentFilter', 'sanctionProgramFilter']
          .forEach(function (id) {
            var field = byId(id);
            if (!field) return;
            if (field.multiple) {
              Array.prototype.forEach.call(field.options, function (option) {
                option.selected = false;
              });
            } else {
              field.value = '';
            }
          });
        // Dropping the department filter widens the program list again.
        populateSanctionProgramSelect();
        loadSanctionReport();
      });
    }

    var printSanction = byId('printSanctionBtn');
    if (printSanction) printSanction.addEventListener('click', printSanctionReport);

    var exportSanction = byId('exportSanctionCsvBtn');
    if (exportSanction) exportSanction.addEventListener('click', exportSanctionExcel);

    window.addEventListener('beforeprint', function () {
      updatePrintMeta();
      updateSanctionPrintMeta();
      setSanctionMatrixPrintVisible(true);
    });

    window.addEventListener('afterprint', function () {
      setSanctionMatrixPrintVisible(false);
    });

    // refreshEvents() was already awaited above, so the event cache is
    // current here. The remaining selects only read from localStorage; we
    // fill them and then build both reports in parallel.
    populateEventSelect();
    populateSanctionEventSelect();
    populateDepartmentSelect();
    populateProgramSelect();
    populateYearSelect();
    populateSanctionSemesterSelect();
    populateSanctionDepartmentSelect();
    populateSanctionProgramSelect();
    await Promise.all([generateAttendanceReport(), loadSanctionReport()]);
  }

  window.ReportsPage = {
    init: init,
    generateAttendanceReport: generateAttendanceReport,
    loadSanctionReport: loadSanctionReport,
    renderSanctionReport: renderSanctionReport,
    printReport: printReport,
    printSanctionReport: printSanctionReport,
    exportCsv: exportCsv,
    exportExcel: exportExcel,
    exportSanctionCsv: exportSanctionCsv,
    exportSanctionExcel: exportSanctionExcel
  };
})();

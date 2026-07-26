// WellSky Shift Scanner — Apps Script Web App
//
// Bind this script to the destination Google Sheet (Extensions > Apps
// Script). Deploy as a Web App and paste the resulting URL into the Chrome
// extension's Settings. See ../README.md for full deployment steps.
//
// Writes:
// - "Shifts": one row per shift, the raw scanned detail (audit trail).
// - One "Hours - <Month> <Year>" tab per calendar month that has any data,
//   e.g. "Hours - July 2026" — built/rebuilt from "Shifts" on every scan.
//   Caregiver names down the side, every day of that month across the top
//   (not just days that have been scanned — a scan only ever covers about a
//   week, so the full month is laid out up front and fills in as more weeks
//   get scanned). Each cell is colored by that day's shift status and shows
//   whatever's relevant for that status (see resolveCell below): completed
//   hours as a decimal, "ongoing" for in-progress shifts, 0 for incomplete
//   (missing clock in/out), or the cancellation note for a cancelled shift.
//   A day with no shift at all shows "-". This is HR's working view — no
//   separate report needed.
//
//   Every cell with a shift also gets a hover note (Sheets cell note, not
//   its content) breaking down each client visit that day, e.g.:
//     A. Palapati (3:00 PM - 6:00 PM: 3)
//     S. Palapati (6:15 PM - 9:00 PM: 2.75)
//   — since a caregiver can work more than one client in a day, but the
//   cell itself is always just that caregiver's one summed total for the day.

var SHEET_NAME = 'Shifts';

var MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

var HEADERS = [
  'caregiver_name',
  'client_name',
  'shift_date',
  'time_in',
  'time_out',
  'status',
  'status_raw',
  'note',
  'event_id',
  'scanned_at',
];

var STATUS_COLORS = {
  completed: '#d4edda', // green — real hours computed
  incomplete: '#f8d7da', // red — missing clock in/out
  upcoming: '#1c4587', // dark blue — scheduled, hasn't happened yet
  ongoing: '#fff9b0', // yellow — in progress
  unparsed: '#fff3cd', // unrecognized status token, needs a look
  cancelled_by_caregiver: '#ffe0b2', // orange
  cancelled_by_office: '#ffb74d', // darker orange
  cancelled_by_client: '#81d4fa', // sky blue — cancelled by client/family
};

// Dark backgrounds need white text to stay readable; anything not listed
// here keeps the sheet's default (black) text.
var STATUS_FONT_COLORS = {
  upcoming: '#ffffff',
};

// Priority order used to pick ONE color/value for a cell when a caregiver
// had more than one shift on the same day with different statuses —
// whichever needs the most attention wins. Cancellation reasons are checked
// in this order too, in case more than one applies (rare, but shifts can
// stack on one day).
var CANCELLED_STATUSES = ['cancelled_by_caregiver', 'cancelled_by_office', 'cancelled_by_client'];

var WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var payload = JSON.parse(e.postData.contents);
    var records = Array.isArray(payload) ? payload : payload.records || [];
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getOrCreateShiftsSheet(ss);
    upsertRecords(sheet, records);
    rebuildHoursPivot(ss);
    return jsonResponse({ ok: true, count: records.length });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return jsonResponse({ ok: true, message: 'WellSky Shift Scanner Apps Script is running.' });
}

function getOrCreateShiftsSheet(ss) {
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  } else {
    // Sheet already exists from before a HEADERS column was added (e.g.
    // "note") — extend the header row rather than losing existing data.
    var existingCols = sheet.getLastColumn();
    if (existingCols < HEADERS.length) {
      sheet
        .getRange(1, existingCols + 1, 1, HEADERS.length - existingCols)
        .setValues([HEADERS.slice(existingCols)]);
    }
  }
  return sheet;
}

// event_id (WellSky's own internal ID for the shift) is the most reliable
// dedup key when present — it survives name/date formatting quirks and
// correctly keeps same-day, same-caregiver, same-client shifts separate.
// Falls back to the documented (caregiver, client, date, time_in) key for
// any record that's missing one.
function dedupeKey(record) {
  if (record.event_id) return 'id:' + record.event_id;
  return ['key', record.caregiver_name, record.client_name, record.shift_date, record.time_in].join('|');
}

function upsertRecords(sheet, records) {
  var lastRow = sheet.getLastRow();
  var numCols = HEADERS.length;
  var existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, numCols).getValues() : [];

  var keyToRow = {};
  existing.forEach(function (row, idx) {
    keyToRow[dedupeKey(rowToRecord(row))] = idx + 2; // 1-based rows, +1 to skip the header
  });

  records.forEach(function (record) {
    var key = dedupeKey(record);
    var values = HEADERS.map(function (h) {
      var v = record[h];
      return v === undefined || v === null ? '' : v;
    });

    var rowNum = keyToRow[key];
    if (!rowNum) {
      lastRow += 1;
      rowNum = lastRow;
      keyToRow[key] = rowNum;
    }
    // Force plain text so Sheets doesn't "helpfully" auto-convert
    // shift_date/time_in/time_out into real dates/times, which would
    // silently break the string parsing the Hours pivot depends on.
    var range = sheet.getRange(rowNum, 1, 1, numCols);
    range.setNumberFormat('@');
    range.setValues([values]);
    applyStatusFormatting(sheet, rowNum, numCols, record.status);
  });
}

function rowToRecord(row) {
  var record = {};
  HEADERS.forEach(function (h, i) {
    record[h] = row[i];
  });
  return record;
}

function applyStatusFormatting(sheet, rowNum, numCols, status) {
  var range = sheet.getRange(rowNum, 1, 1, numCols);
  range.setBackground(STATUS_COLORS[status] || null);
  range.setFontColor(STATUS_FONT_COLORS[status] || null);
}

// time_in/time_out are stored as 12-hour strings like "8:41 AM". Converts
// back to minutes-since-midnight, or null if blank/unparsable (which is
// expected for incomplete shifts — there's no real time to compute from).
function parseClockString(str) {
  if (!str) return null;
  var m = String(str).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  var hour = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) hour += 12;
  return hour * 60 + parseInt(m[2], 10);
}

// Payroll's official quarter-hour rounding rule (nearest-quarter, not
// round-up): minutes past the hour —
//   0-7 → :00, 8-22 → :15, 23-37 → :30, 38-52 → :45, 53-60 → next full hour.
// E.g. 2h17m → 2.25 (17 falls in the 8-22 bucket).
function roundToQuarterHour(totalMinutes) {
  var wholeHours = Math.floor(totalMinutes / 60);
  var remainder = totalMinutes % 60;
  var fraction;
  if (remainder <= 7) fraction = 0;
  else if (remainder <= 22) fraction = 0.25;
  else if (remainder <= 37) fraction = 0.5;
  else if (remainder <= 52) fraction = 0.75;
  else fraction = 1;
  return wholeHours + fraction;
}

function computeHours(timeIn, timeOut) {
  var start = parseClockString(timeIn);
  var end = parseClockString(timeOut);
  if (start === null || end === null) return null;
  var diffMinutes = end - start;
  if (diffMinutes < 0) diffMinutes += 24 * 60; // shift crosses midnight
  return roundToQuarterHour(diffMinutes);
}

// "Aaron Palapati" -> "A. Palapati" — first-name initial + last name(s), so
// a caregiver's multiple clients fit on one line each in the hover note.
function abbreviateClientName(name) {
  if (!name) return 'Unknown client';
  var parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return parts[0].charAt(0).toUpperCase() + '. ' + parts.slice(1).join(' ');
}

// One line of a cell's hover note, e.g. "A. Palapati (3:00 PM - 6:00 PM: 3)"
// — used so a caregiver who worked more than one client in a day gets each
// visit broken out, even though the cell itself only shows the day's total.
function describeShiftDetail(record) {
  var label = abbreviateClientName(record.client_name);
  if (record.time_in && record.time_out) {
    var hours = computeHours(record.time_in, record.time_out);
    return label + ' (' + record.time_in + ' - ' + record.time_out + ': ' + (hours === null ? '?' : hours) + ')';
  }
  if (record.time_in) return label + ' (Clocked in ' + record.time_in + ', no clock out recorded)';
  if (record.time_out) return label + ' (Clocked out ' + record.time_out + ', no clock in recorded)';
  return label + ' (no times recorded)';
}

function formatDateHeader(isoDate) {
  var parts = isoDate.split('-');
  return parseInt(parts[1], 10) + '/' + parseInt(parts[2], 10);
}

function getWeekdayName(isoDate) {
  var parts = isoDate.split('-').map(Number);
  var d = new Date(parts[0], parts[1] - 1, parts[2]);
  return WEEKDAY_NAMES[d.getDay()];
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// "2026-07" -> "2026-07-05" for day 5. Matches the zero-padded shift_date
// format scan-script.js already writes, so these line up as cellMap keys.
function isoDateForDay(year, month, day) {
  return year + '-' + pad2(month) + '-' + pad2(day);
}

// Day 0 of "next month" is the last day of "this month" — the standard JS
// trick for days-in-month, month here is 1-indexed to match monthKey.
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function monthKeyFromIso(isoDate) {
  return isoDate.slice(0, 7); // "YYYY-MM"
}

function monthSheetName(monthKey) {
  var parts = monthKey.split('-');
  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10);
  return 'Hours - ' + MONTH_NAMES[month - 1] + ' ' + year;
}

// Picks what a single caregiver/date cell shows, when that day may have had
// more than one shift with different statuses. Whichever needs the most
// attention wins the color and the displayed value:
//   incomplete  > cancelled (whichever reason)  > ongoing  > unparsed
//   > upcoming  > completed (fall-through: just the computed hours)
function cellResult(value, status) {
  return { value: value, color: STATUS_COLORS[status], fontColor: STATUS_FONT_COLORS[status] || null };
}

function resolveCell(cell) {
  if (!cell || !cell.hasData) return { value: '-', color: null, fontColor: null };

  if (cell.statuses.incomplete) {
    return cellResult(cell.hoursSum, 'incomplete');
  }

  for (var i = 0; i < CANCELLED_STATUSES.length; i++) {
    var s = CANCELLED_STATUSES[i];
    if (cell.statuses[s]) {
      return cellResult(cell.notes.join('; '), s);
    }
  }

  if (cell.statuses.ongoing) {
    return cellResult('ongoing', 'ongoing');
  }

  if (cell.statuses.unparsed) {
    return cellResult('', 'unparsed');
  }

  if (cell.statuses.upcoming) {
    return cellResult('', 'upcoming');
  }

  return cellResult(cell.hoursSum, 'completed');
}

// Groups every row currently in "Shifts" by calendar month (a single scan
// only ever covers about a week, and that week can straddle two different
// months' tables — bucketing by each record's own shift_date, rather than
// by whatever week was scanned, is what keeps that split correct), then
// rebuilds each month's "Hours - <Month> <Year>" tab from scratch.
function rebuildHoursPivot(ss) {
  var shiftsSheet = ss.getSheetByName(SHEET_NAME);
  if (!shiftsSheet) return;
  var lastRow = shiftsSheet.getLastRow();
  if (lastRow < 2) return;

  var data = shiftsSheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();

  var months = {}; // "YYYY-MM" -> { caregiverSet, cellMap }

  data.forEach(function (row) {
    var record = rowToRecord(row);
    var caregiver = record.caregiver_name;
    var date = record.shift_date;
    if (!caregiver || !date) return;

    var monthKey = monthKeyFromIso(date);
    if (!months[monthKey]) months[monthKey] = { caregiverSet: {}, cellMap: {} };
    var month = months[monthKey];
    month.caregiverSet[caregiver] = true;

    var key = caregiver + '|' + date;
    if (!month.cellMap[key]) {
      month.cellMap[key] = { hoursSum: 0, hasData: false, statuses: {}, notes: [], shiftDetails: [] };
    }
    var cell = month.cellMap[key];
    cell.hasData = true;
    cell.statuses[record.status] = true;

    if (record.status === 'completed') {
      var hours = computeHours(record.time_in, record.time_out);
      if (hours !== null) cell.hoursSum += hours;
    }

    if (record.note) cell.notes.push(record.note);

    var detail = describeShiftDetail(record);
    if (detail) cell.shiftDetails.push(detail);
  });

  Object.keys(months).forEach(function (monthKey) {
    writeMonthTable(ss, monthKey, months[monthKey]);
  });
}

// Writes one month's full "Hours - <Month> <Year>" tab: every day of that
// month across the top (day 1 through the last day, whether or not it's
// been scanned yet — unscanned days just show "-"), every caregiver seen
// in that month down the side. Gets/creates the tab by name and always
// rewrites it wholesale, same as the old single-tab version did.
function writeMonthTable(ss, monthKey, monthData) {
  var parts = monthKey.split('-');
  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10);
  var numDays = daysInMonth(year, month);

  var sheetName = monthSheetName(monthKey);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  } else {
    sheet.clear();
  }

  var dates = [];
  for (var d = 1; d <= numDays; d++) dates.push(isoDateForDay(year, month, d));

  var caregivers = Object.keys(monthData.caregiverSet).sort();
  if (caregivers.length === 0) return;

  var dateHeaderRow = [''].concat(dates.map(formatDateHeader));
  var weekdayHeaderRow = [''].concat(dates.map(getWeekdayName));
  var headerRange = sheet.getRange(1, 1, 2, dateHeaderRow.length);
  headerRange.setNumberFormat('@'); // keep "7/25" as text, not an auto-converted date
  sheet.getRange(1, 1, 1, dateHeaderRow.length).setValues([dateHeaderRow]);
  sheet.getRange(2, 1, 1, weekdayHeaderRow.length).setValues([weekdayHeaderRow]);
  headerRange.setFontWeight('bold');

  sheet.getRange(3, 1, caregivers.length, 1).setNumberFormat('@');
  var resolved = caregivers.map(function (caregiver) {
    return dates.map(function (date) {
      return resolveCell(monthData.cellMap[caregiver + '|' + date]);
    });
  });

  var outputRows = caregivers.map(function (caregiver, rIdx) {
    return [caregiver].concat(
      resolved[rIdx].map(function (r) {
        return r.value;
      })
    );
  });
  sheet.getRange(3, 1, outputRows.length, dateHeaderRow.length).setValues(outputRows);

  caregivers.forEach(function (caregiver, rIdx) {
    dates.forEach(function (date, cIdx) {
      var r = resolved[rIdx][cIdx];
      var range = sheet.getRange(rIdx + 3, cIdx + 2);
      if (r.color) {
        range.setBackground(r.color);
      }
      if (r.fontColor) {
        range.setFontColor(r.fontColor);
      }
      var cell = monthData.cellMap[caregiver + '|' + date];
      if (cell && cell.shiftDetails.length > 0) {
        range.setNote(cell.shiftDetails.join('\n'));
      }
    });
  });

  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(1);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

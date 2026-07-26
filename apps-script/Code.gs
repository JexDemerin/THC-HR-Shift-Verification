// WellSky Shift Scanner — Apps Script Web App
//
// Bind this script to the destination Google Sheet (Extensions > Apps
// Script). Deploy as a Web App and paste the resulting URL into the Chrome
// extension's Settings. See ../README.md for full deployment steps.
//
// Writes two tabs:
// - "Shifts": one row per shift, the raw scanned detail (audit trail).
// - "Hours": a pivot built from "Shifts" — caregiver names down the side,
//   dates across the top, decimal hours worked in each cell. A cell is
//   colored when that caregiver had an incomplete (missing clock in/out)
//   shift that day, so it's visible at a glance which day/caregiver needs
//   follow-up, without a separate report.

var SHEET_NAME = 'Shifts';
var HOURS_SHEET_NAME = 'Hours';

var HEADERS = [
  'caregiver_name',
  'client_name',
  'shift_date',
  'time_in',
  'time_out',
  'status',
  'status_raw',
  'event_id',
  'scanned_at',
];

var STATUS_COLORS = {
  incomplete: '#f8d7da',
  unparsed: '#fff3cd',
  completed: '#d4edda',
  upcoming: '#d1ecf1',
  ongoing: '#fff8b3',
  cancelled: '#e2e3e5',
};

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
    if (rowNum) {
      sheet.getRange(rowNum, 1, 1, numCols).setValues([values]);
    } else {
      sheet.appendRow(values);
      rowNum = sheet.getLastRow();
      keyToRow[key] = rowNum;
    }
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

function computeHours(timeIn, timeOut) {
  var start = parseClockString(timeIn);
  var end = parseClockString(timeOut);
  if (start === null || end === null) return null;
  var diffMinutes = end - start;
  if (diffMinutes < 0) diffMinutes += 24 * 60; // shift crosses midnight
  return Math.round((diffMinutes / 60) * 100) / 100;
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

// Rebuilds the "Hours" tab from scratch out of every row currently in
// "Shifts": one row per caregiver, one column per date seen so far, cell
// value is total decimal hours worked that day (summed if there were
// multiple shifts), colored if any shift that day for that caregiver was
// incomplete or unparsed.
function rebuildHoursPivot(ss) {
  var shiftsSheet = ss.getSheetByName(SHEET_NAME);
  if (!shiftsSheet) return;
  var lastRow = shiftsSheet.getLastRow();

  var hoursSheet = ss.getSheetByName(HOURS_SHEET_NAME);
  if (!hoursSheet) {
    hoursSheet = ss.insertSheet(HOURS_SHEET_NAME);
  } else {
    hoursSheet.clear();
  }
  if (lastRow < 2) return;

  var data = shiftsSheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();

  var caregiverSet = {};
  var dateSet = {};
  var cellMap = {};

  data.forEach(function (row) {
    var record = rowToRecord(row);
    var caregiver = record.caregiver_name;
    var date = record.shift_date;
    if (!caregiver || !date) return;

    caregiverSet[caregiver] = true;
    dateSet[date] = true;

    var key = caregiver + '|' + date;
    if (!cellMap[key]) cellMap[key] = { hours: 0, hasData: false, flagStatus: null };
    cellMap[key].hasData = true;

    if (record.status === 'incomplete') {
      cellMap[key].flagStatus = 'incomplete';
    } else if (record.status === 'unparsed' && cellMap[key].flagStatus !== 'incomplete') {
      cellMap[key].flagStatus = 'unparsed';
    }

    var hours = computeHours(record.time_in, record.time_out);
    if (hours !== null) cellMap[key].hours += hours;
  });

  var caregivers = Object.keys(caregiverSet).sort();
  var dates = Object.keys(dateSet).sort();
  if (caregivers.length === 0 || dates.length === 0) return;

  var dateHeaderRow = [''].concat(dates.map(formatDateHeader));
  var weekdayHeaderRow = [''].concat(dates.map(getWeekdayName));
  hoursSheet.getRange(1, 1, 1, dateHeaderRow.length).setValues([dateHeaderRow]);
  hoursSheet.getRange(2, 1, 1, weekdayHeaderRow.length).setValues([weekdayHeaderRow]);
  hoursSheet.getRange(1, 1, 2, dateHeaderRow.length).setFontWeight('bold');

  var outputRows = caregivers.map(function (caregiver) {
    return [caregiver].concat(
      dates.map(function (date) {
        var cell = cellMap[caregiver + '|' + date];
        return cell && cell.hasData ? cell.hours : '';
      })
    );
  });
  hoursSheet.getRange(3, 1, outputRows.length, dateHeaderRow.length).setValues(outputRows);

  caregivers.forEach(function (caregiver, rIdx) {
    dates.forEach(function (date, cIdx) {
      var cell = cellMap[caregiver + '|' + date];
      if (cell && cell.flagStatus) {
        hoursSheet
          .getRange(rIdx + 3, cIdx + 2)
          .setBackground(STATUS_COLORS[cell.flagStatus]);
      }
    });
  });

  hoursSheet.setFrozenRows(2);
  hoursSheet.setFrozenColumns(1);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

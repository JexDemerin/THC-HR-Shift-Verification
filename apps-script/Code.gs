// WellSky Shift Scanner — Apps Script Web App
//
// Bind this script to the destination Google Sheet (Extensions > Apps
// Script). Deploy as a Web App and paste the resulting URL into the Chrome
// extension's Settings. See ../README.md for full deployment steps.
//
// Writes:
// - "Shifts": one row per shift, the raw scanned detail (audit trail).
// - TIMESHEETS_SHEET_NAME below (the real, human-maintained payroll tab,
//   e.g. "2026 Caregivers TimeSheets Record") — never created, only ever
//   written into. That tab is laid out as a series of date-header blocks
//   stacked vertically down the sheet (a new block roughly every 28 days,
//   each with its own row of "M/DD" date headers and a caregiver-name row
//   below it), extended by hand over time rather than generated. Rather
//   than compute date math and guess at that structure, every scan:
//     1. Scans the tab once for rows that look like date-header rows
//        (findDateHeaderRows) and indexes each block's date->column and
//        caregiver-name->row lookups (buildTimesheetIndex).
//     2. For each (caregiver, date) with shift data, looks up the real
//        header cell(s) that already match that exact date and caregiver,
//        and writes only that single cell — value, color, and hover note.
//   A shift whose date has no matching header yet (e.g. today, before
//   payroll has extended the table that far) is skipped rather than
//   fabricating a new block — this tab's structure is HR's to maintain,
//   the script only fills in cells that already exist for it to find.
//
//   A cell's value/color is picked by that day's shift status (see
//   resolveCell): completed hours as a decimal, "ongoing" for in-progress
//   shifts, 0 for incomplete (missing clock in/out), or the cancellation
//   note for a cancelled shift.
//
//   Every cell with a shift also gets a hover note (Sheets cell note, not
//   its content) breaking down each client visit that day, e.g.:
//     A. Palapati (3:00 PM - 6:00 PM: 3)
//     S. Palapati (6:15 PM - 9:00 PM: 2.75)
//   — since a caregiver can work more than one client in a day, but the
//   cell itself is always just that caregiver's one summed total for the day.

var SHEET_NAME = 'Shifts';

// The real payroll tab name — confirm this matches your sheet exactly
// (Sheets truncates long tab labels in the UI, e.g. to "...TimeSheets
// Reco", but the underlying name is the full string below). This tab is
// never created or cleared by the script — if it's missing, nothing gets
// written and rebuildHoursPivot silently no-ops.
var TIMESHEETS_SHEET_NAME = '2026 Caregivers TimeSheets Record';

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

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    // Outside the main try/catch on purpose: if waitLock itself throws (a
    // concurrent scan still holding the lock) and this isn't caught here,
    // Apps Script returns an uncaught-exception HTML page instead of JSON,
    // which the extension can't parse into a useful error message.
    return jsonResponse({ ok: false, error: 'Could not acquire script lock (another scan may still be running): ' + describeError(err) });
  }

  try {
    var payload = JSON.parse(e.postData.contents);
    var records = Array.isArray(payload) ? payload : payload.records || [];
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getOrCreateShiftsSheet(ss);
    upsertRecords(sheet, records);
    var pivotSummary = rebuildHoursPivot(ss);
    return jsonResponse({ ok: true, count: records.length, pivotSummary: pivotSummary });
  } catch (err) {
    return jsonResponse({ ok: false, error: describeError(err) });
  } finally {
    lock.releaseLock();
  }
}

// err.message is usually present, but a thrown non-Error value (a plain
// string, or certain Apps Script service errors) can leave it undefined —
// falling back to String(err) means the caller never sees a blank/"unknown"
// error with no way to tell what actually happened.
function describeError(err) {
  return (err && err.message) || String(err);
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

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// "2026-01-04" -> "1/04" — matches the real sheet's header format exactly:
// month with no leading zero, day always 2 digits.
function formatDateHeader(isoDate) {
  var parts = isoDate.split('-');
  return parseInt(parts[1], 10) + '/' + pad2(parseInt(parts[2], 10));
}

// Matches a date-header cell's displayed text like "1/04" or "10/25" — not a
// full calendar date, so this only ever appears in the header row of one of
// the tab's date blocks.
var DATE_HEADER_PATTERN = /^\d{1,2}\/\d{2}$/;

// A header row needs at least this many cells resolving to a date key
// (via headerCellDateKey) to count as a real date-header row, rather than a
// coincidental match.
var MIN_DATE_HEADER_CELLS = 5;

// A header cell might be a real Date value formatted to display like "1/04"
// rather than the plain text "1/04" itself — getValues() returns actual JS
// Date objects for those, which DATE_HEADER_PATTERN would never match as a
// string. Handle both so header detection works either way.
function headerCellDateKey(cell) {
  if (Object.prototype.toString.call(cell) === '[object Date]') {
    return (cell.getMonth() + 1) + '/' + pad2(cell.getDate());
  }
  var text = String(cell).trim();
  return DATE_HEADER_PATTERN.test(text) ? text : null;
}

// "Albulasi, Wesam" and "Wesam Albulasi" both normalize to the same key, so
// caregiver names can be matched regardless of which order the sheet (or
// the Shifts data) happens to use — the real tab mixes both formats.
function normalizeName(name) {
  if (!name) return '';
  var commaParts = String(name).split(',');
  var canonical = commaParts.length === 2 ? commaParts[1] + ' ' + commaParts[0] : commaParts[0];
  return canonical.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Scans the whole timesheets tab once for rows that look like date-header
// rows (the row of "1/04", "1/05", ... cells at the top of each of the
// tab's stacked date blocks). Returns one entry per header row found:
// { row: <1-based row>, columnsByDate: { "1/04": [colIndex, ...], ... } }
// — an array of columns per date since a block's stale/duplicate week can
// repeat the same date in more than one column.
function findDateHeaderRows(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) return [];
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  var headerRows = [];
  values.forEach(function (rowValues, idx) {
    var columnsByDate = {};
    var matches = 0;
    rowValues.forEach(function (cell, colIdx) {
      var dateKey = headerCellDateKey(cell);
      if (dateKey) {
        matches++;
        if (!columnsByDate[dateKey]) columnsByDate[dateKey] = [];
        columnsByDate[dateKey].push(colIdx + 1); // 1-based column
      }
    });
    if (matches >= MIN_DATE_HEADER_CELLS) {
      headerRows.push({ row: idx + 1, columnsByDate: columnsByDate });
    }
  });
  return headerRows;
}

// A block's caregiver rows start 2 rows below its date-header row (skipping
// the weekday sub-header directly below the dates) and run until the row
// right before the next date-header row (or the sheet's last row, for the
// final block).
function buildTimesheetIndex(sheet) {
  var headerRows = findDateHeaderRows(sheet);
  var lastRow = sheet.getLastRow();

  return headerRows.map(function (header, i) {
    var startRow = header.row + 2;
    var nextHeaderRow = headerRows[i + 1] ? headerRows[i + 1].row : null;
    var endRow = nextHeaderRow ? nextHeaderRow - 1 : lastRow;

    var nameMap = {};
    if (endRow >= startRow) {
      var names = sheet.getRange(startRow, 1, endRow - startRow + 1, 1).getValues();
      names.forEach(function (n, idx) {
        var key = normalizeName(n[0]);
        if (key) nameMap[key] = startRow + idx;
      });
    }

    return { columnsByDate: header.columnsByDate, nameMap: nameMap };
  });
}

// Finds every (block index, row, column) location across the given blocks
// whose header already has this exact date and whose caregiver rows
// already include this exact caregiver — pure lookup, no sheet writes, so
// callers can batch the actual writes per block instead of hitting the
// sheet once per individual cell. Returns { matches, status }, where status
// is 'written' (1+ matches), 'no_date_match', or 'no_caregiver_match' — the
// two miss reasons this otherwise fails silently by design (a shift with
// nowhere to go yet is expected, not an error).
function findTimesheetMatches(blocks, caregiverName, isoDate) {
  var dateKey = formatDateHeader(isoDate);
  var nameKey = normalizeName(caregiverName);
  var matches = [];
  var sawDate = false;
  var sawCaregiver = false;

  blocks.forEach(function (block, blockIdx) {
    var cols = block.columnsByDate[dateKey];
    var row = block.nameMap[nameKey];
    if (cols) sawDate = true;
    if (row) sawCaregiver = true;
    if (!cols || !row) return;
    cols.forEach(function (col) {
      matches.push({ blockIdx: blockIdx, row: row, col: col });
    });
  });

  var status = matches.length > 0 ? 'written' : sawDate ? 'no_caregiver_match' : 'no_date_match';
  return { matches: matches, status: status };
}

// Applies every pending cell write in one batch per block — one bounding
// rectangle covering all of that block's touched cells, read once and
// written back once — rather than the 4-5 separate Apps Script service
// calls per individual cell this used to take. For a scan touching a
// couple hundred cells, that's the difference between a handful of calls
// and enough round trips to risk timing out the next scan's lock wait.
// pendingByBlockIndex: { blockIdx: [{ row, col, resolved }, ...] }.
function applyPendingWrites(sheet, pendingByBlockIndex) {
  Object.keys(pendingByBlockIndex).forEach(function (blockIdxKey) {
    var pending = pendingByBlockIndex[blockIdxKey];
    if (!pending || pending.length === 0) return;

    var minRow = pending[0].row,
      maxRow = pending[0].row,
      minCol = pending[0].col,
      maxCol = pending[0].col;
    pending.forEach(function (p) {
      if (p.row < minRow) minRow = p.row;
      if (p.row > maxRow) maxRow = p.row;
      if (p.col < minCol) minCol = p.col;
      if (p.col > maxCol) maxCol = p.col;
    });

    var range = sheet.getRange(minRow, minCol, maxRow - minRow + 1, maxCol - minCol + 1);
    range.setNumberFormat('@');

    var values = range.getValues();
    var backgrounds = range.getBackgrounds();
    var fontColors = range.getFontColors();
    var notes = range.getNotes();

    pending.forEach(function (p) {
      var r = p.row - minRow;
      var c = p.col - minCol;
      values[r][c] = p.resolved.value;
      backgrounds[r][c] = p.resolved.color || '';
      fontColors[r][c] = p.resolved.fontColor || '';
      notes[r][c] = p.resolved.note || '';
    });

    range.setValues(values);
    range.setBackgrounds(backgrounds);
    range.setFontColors(fontColors);
    range.setNotes(notes);
  });
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

// Caps how many "here's an example of what got skipped" entries go back in
// the scan response — enough to diagnose a problem without bloating it.
var MAX_PIVOT_SAMPLES = 10;

// Aggregates every row currently in "Shifts" by (caregiver, date) — a
// caregiver can have more than one shift the same day (different clients),
// and each one only ever has one cell to land in — then writes each
// aggregated cell into the real timesheets tab, wherever a matching date
// header + caregiver row already exists for it. Never clears or rebuilds
// anything; a shift with nowhere to go yet is skipped rather than
// fabricated, but every skip is tallied into the returned summary (rather
// than failing silently) so a scan can be diagnosed from its response
// alone instead of having to guess why the sheet didn't change.
function rebuildHoursPivot(ss) {
  var summary = { headerBlocksFound: 0, cellsResolved: 0, written: 0, skippedNoDateMatch: [], skippedNoCaregiverMatch: [] };

  var shiftsSheet = ss.getSheetByName(SHEET_NAME);
  if (!shiftsSheet) return summary;
  var lastRow = shiftsSheet.getLastRow();
  if (lastRow < 2) return summary;

  var timesheetSheet = ss.getSheetByName(TIMESHEETS_SHEET_NAME);
  if (!timesheetSheet) {
    summary.error = 'Timesheets tab "' + TIMESHEETS_SHEET_NAME + '" not found';
    return summary;
  }

  var data = shiftsSheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();

  var cellMap = {}; // "caregiver|date" -> { caregiver, date, hoursSum, hasData, statuses, notes, shiftDetails }

  data.forEach(function (row) {
    var record = rowToRecord(row);
    var caregiver = record.caregiver_name;
    var date = record.shift_date;
    if (!caregiver || !date) return;

    var key = caregiver + '|' + date;
    if (!cellMap[key]) {
      cellMap[key] = { caregiver: caregiver, date: date, hoursSum: 0, hasData: false, statuses: {}, notes: [], shiftDetails: [] };
    }
    var cell = cellMap[key];
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

  var blocks = buildTimesheetIndex(timesheetSheet);
  summary.headerBlocksFound = blocks.length;

  var pendingByBlockIndex = {}; // blockIdx -> [{ row, col, resolved }, ...]

  Object.keys(cellMap).forEach(function (key) {
    var entry = cellMap[key];
    var resolved = resolveCell(entry);
    resolved.note = entry.shiftDetails.length > 0 ? entry.shiftDetails.join('\n') : null;
    summary.cellsResolved++;

    var found = findTimesheetMatches(blocks, entry.caregiver, entry.date);
    if (found.status === 'written') {
      summary.written++;
      found.matches.forEach(function (m) {
        if (!pendingByBlockIndex[m.blockIdx]) pendingByBlockIndex[m.blockIdx] = [];
        pendingByBlockIndex[m.blockIdx].push({ row: m.row, col: m.col, resolved: resolved });
      });
    } else {
      var sample = entry.caregiver + ' @ ' + entry.date;
      var bucket = found.status === 'no_date_match' ? summary.skippedNoDateMatch : summary.skippedNoCaregiverMatch;
      if (bucket.length < MAX_PIVOT_SAMPLES) bucket.push(sample);
    }
  });

  applyPendingWrites(timesheetSheet, pendingByBlockIndex);

  return summary;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

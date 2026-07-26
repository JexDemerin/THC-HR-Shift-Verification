// Phase 1/2 — real shift scanner.
//
// Runs only when injected on demand from popup.js after the user clicks
// "Scan Schedule" — never automatically. Built against real WellSky
// (ClearCare Online) markup confirmed via Phase 0 "Export Raw HTML"
// captures: each caregiver is a <tr class="sched_row">, and each shift is a
// <div class="_event STATUS_TOKEN ajSet" data-event-id data-event-type
// data-start data-end> living inside a <td class="day-data">.

(function () {
  const STATUS_MAP = {
    SCHEDULED: 'upcoming',
    IN_PROGRESS: 'ongoing',
    COMPLETED: 'completed',
    MISSED_CLOCK_IN: 'incomplete',
    MISSED_CLOCK_OUT: 'incomplete',
    CANCELLED_BY_CAREGIVER: 'cancelled',
    CANCELLED_BY_CLIENT: 'cancelled',
    CANCELLED_BY_OFFICE: 'cancelled',
  };

  // data-start/data-end always have a value, even when nothing was actually
  // clocked (a missed clock-in still shows the *scheduled* start time there).
  // The only way to tell a real punch from a scheduled placeholder is that
  // real punches carry fractional seconds (e.g. ".441484") while
  // placeholders always land exactly on the minute.
  function parseTimestamp(raw) {
    if (!raw) return null;
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?/);
    if (!m) return null;
    return {
      date: `${m[1]}-${m[2]}-${m[3]}`,
      hour: parseInt(m[4], 10),
      minute: parseInt(m[5], 10),
      isReal: Boolean(m[7]),
    };
  }

  function formatTime12h(t) {
    if (!t) return null;
    const h12 = ((t.hour + 11) % 12) + 1;
    const ampm = t.hour < 12 ? 'AM' : 'PM';
    return `${h12}:${String(t.minute).padStart(2, '0')} ${ampm}`;
  }

  function extractClientName(eventEl) {
    const nameAnchor = eventEl.querySelector('.title .name');
    if (!nameAnchor) return null;
    const clone = nameAnchor.cloneNode(true);
    const timeSpan = clone.querySelector('.time');
    if (timeSpan) timeSpan.remove();
    const text = clone.textContent.replace(/\s+/g, ' ').trim();
    return text || null;
  }

  function extractRecord(caregiverName, eventEl) {
    const statusToken =
      Array.from(eventEl.classList).find((c) => c !== '_event' && c !== 'ajSet') || null;
    const mappedStatus = statusToken ? STATUS_MAP[statusToken] : undefined;

    const start = parseTimestamp(eventEl.getAttribute('data-start'));
    const end = parseTimestamp(eventEl.getAttribute('data-end'));
    const clientName = extractClientName(eventEl);
    const shiftDate = (start && start.date) || (end && end.date) || null;

    let timeIn = null;
    let timeOut = null;
    if (statusToken === 'MISSED_CLOCK_IN') {
      timeOut = end && end.isReal ? formatTime12h(end) : null;
    } else if (statusToken === 'MISSED_CLOCK_OUT') {
      timeIn = start && start.isReal ? formatTime12h(start) : null;
    } else if (statusToken === 'IN_PROGRESS') {
      timeIn = start ? formatTime12h(start) : null; // ongoing shifts have no end time yet, by design
    } else {
      timeIn = start ? formatTime12h(start) : null;
      timeOut = end ? formatTime12h(end) : null;
    }

    const isConfident = Boolean(caregiverName && clientName && mappedStatus && shiftDate);

    return {
      caregiver_name: caregiverName || null,
      client_name: clientName,
      shift_date: shiftDate,
      time_in: timeIn,
      time_out: timeOut,
      status: isConfident ? mappedStatus : 'unparsed',
      status_raw: statusToken || eventEl.className,
      event_id: eventEl.getAttribute('data-event-id') || null,
      scanned_at: new Date().toISOString(),
      debug_html: isConfident ? undefined : eventEl.outerHTML.slice(0, 500),
    };
  }

  function scan() {
    const rows = Array.from(document.querySelectorAll('tr.sched_row'));
    const records = [];

    for (const row of rows) {
      const caregiverAnchor = row.querySelector('.person-name a');
      const caregiverName = caregiverAnchor
        ? caregiverAnchor.textContent.replace(/\s+/g, ' ').trim()
        : null;

      const events = Array.from(row.querySelectorAll('.day-data ._event'));
      for (const eventEl of events) {
        records.push(extractRecord(caregiverName, eventEl));
      }
    }

    return { records, rowCount: rows.length };
  }

  const { records, rowCount } = scan();

  const summary = {
    total: records.length,
    completed: records.filter((r) => r.status === 'completed').length,
    incomplete: records.filter((r) => r.status === 'incomplete').length,
    upcoming: records.filter((r) => r.status === 'upcoming').length,
    ongoing: records.filter((r) => r.status === 'ongoing').length,
    cancelled: records.filter((r) => r.status === 'cancelled').length,
    unparsed: records.filter((r) => r.status === 'unparsed').length,
  };

  return {
    records,
    summary,
    rowCount,
    pageUrl: window.location.href,
    scannedAt: new Date().toISOString(),
  };
})();

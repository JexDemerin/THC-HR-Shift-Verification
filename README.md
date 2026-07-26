# WellSky Shift Scanner

A Chrome extension for Together Homecare to catch incomplete (missing clock in/out) shifts in
WellSky before payroll runs. See [`spec.md`](./spec.md) for the full build spec.

## Status: working MVP (Phase 0–3)

Real WellSky markup was captured and confirmed (see "What we learned" below), so the extension
now does the real job:

- **"Scan Schedule"** — reads every shift currently visible on the WellSky schedule, figures out
  its real status, and (if a Google Sheet URL is configured in Settings) sends the results to the
  Sheet, with incomplete shifts flagged.
- **"Export Raw HTML"** — kept as a debugging tool. If a shift ever shows up as "unparsed" (a
  status WellSky uses that the extension doesn't recognize yet), use this to grab the real markup
  and bring it back so the parser can be updated.

Nothing runs automatically — both buttons only act when clicked, and only on whatever is
currently visible in the browser tab.

## Loading the extension in Chrome

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked**.
4. Select the `extension/` folder from this repo.
5. The extension icon should now appear in your toolbar (you may need to pin it via the
   puzzle-piece icon).

After pulling a code update, click the small reload icon on the extension's card in
`chrome://extensions` to pick up the change.

## Using it

1. Log into WellSky and go to the schedule view (`.../dashboard/live/weekly/caregivers/`).
2. Click the extension icon, then click **Scan Schedule**.
3. The popup shows a summary (e.g. "42 shifts found — 3 flagged incomplete") and, if a Sheet URL
   is saved (see Setup below), sends the results there automatically.
4. Scroll or change the view (different week, different caregiver group) and click **Scan
   Schedule** again to cover more shifts — it only reads what's currently on screen.

### If something looks wrong

If a shift comes back with status `unparsed`, it means WellSky used a status label the scanner
doesn't have a mapping for yet (the known ones are listed below). Click **Export Raw HTML** on
that same view, send the downloaded file back to a Claude Code session, and the mapping table in
`extension/scan-script.js` can be extended.

## Setup — Google Sheet integration

1. Create a Google Sheet inside the **Together Homecare Workspace domain** (not a personal
   account — this data includes real client and caregiver names) and restrict sharing to only
   the people who need it.
2. In the Sheet, go to **Extensions → Apps Script**.
3. Delete any starter code and paste in the contents of [`apps-script/Code.gs`](./apps-script/Code.gs).
4. Click **Deploy → New deployment**, choose type **Web app**, set "Execute as" to yourself and
   "Who has access" to whatever fits your security needs (e.g. "Anyone within Together
   Homecare").
5. Click **Deploy**, authorize it when prompted, and copy the Web App URL it gives you.
6. In the extension's popup, open **Settings**, paste the URL into "Google Sheet Web App URL",
   and click **Save**. Chrome will ask you to confirm access to that URL — approve it (this is
   what lets the extension send data there).
7. Click **Scan Schedule** — a `Shifts` tab will be created in the Sheet automatically on first
   send, with the right column headers.

Re-scanning the same shift updates its existing row instead of creating a duplicate. Rows are
color-coded by status directly in the Sheet (red-ish for incomplete, yellow for unparsed) so
follow-up items are impossible to miss.

## What we learned from real WellSky markup (Phase 0 findings)

WellSky (running on the ClearCare Online platform) encodes shifts more precisely than a
five-color legend suggests:

- The schedule is a table where each caregiver is one row (`<tr class="sched_row">`), and each
  shift is a `<div class="_event STATUS ...">` sitting inside that row's column for the relevant
  day.
- The real status names found in the page code are: `SCHEDULED`, `IN_PROGRESS`, `COMPLETED`,
  `MISSED_CLOCK_IN`, `MISSED_CLOCK_OUT`, `CANCELLED_BY_CAREGIVER`, `CANCELLED_BY_CLIENT`,
  `CANCELLED_BY_OFFICE`. These map to our five statuses as: `MISSED_CLOCK_IN` /
  `MISSED_CLOCK_OUT` → incomplete, `SCHEDULED` → upcoming, `IN_PROGRESS` → ongoing, `COMPLETED` →
  completed, and all three `CANCELLED_BY_*` variants → cancelled (the specific reason is kept in
  `status_raw` for reference).
- Every shift already carries its exact date and time in `data-start` / `data-end` attributes, so
  the scanner doesn't need to guess the date from a column header at all — a nice simplification
  over what the spec originally assumed.
- WellSky always fills in a start/end time even when nothing was actually clocked (e.g. a missed
  clock-in still shows a placeholder scheduled start). The tell-tale difference: a real clock
  punch always has odd fractional seconds (e.g. `08:41:00.441484`), while a placeholder is always
  exactly on the minute. The scanner uses this to correctly blank out the time for whichever side
  (in or out) was never actually recorded.

### Known limitations / not yet confirmed with real data

- **Two shifts for the same caregiver on the same day**: every real example captured so far had
  at most one shift per caregiver per day-column. It's not yet confirmed how WellSky would render
  a genuine second same-day shift for the same caregiver — if you hit this in practice, export
  the raw HTML for that case so the parser can be checked against it.
- **Overnight shifts** (e.g. 10 PM–6 AM): not yet seen in a real capture. The scanner assigns
  `shift_date` from the shift's start time, which should handle a midnight crossover correctly,
  but this hasn't been confirmed against a real overnight shift yet.
- Statuses seen in the color legend but not yet captured in real markup (Unavailability
  Approved/Requested/Denied, Tentative/Not Scheduled, Attention Required) aren't in the mapping
  table yet — they don't appear to be caregiver shift events, so they're likely out of scope for
  payroll follow-up, but if one ever shows up as `unparsed`, export it and it can be added.

# WellSky Shift Scanner

A Chrome extension for Together Homecare to catch incomplete (missing clock in/out) shifts in
WellSky before payroll runs. See [`spec.md`](./spec.md) for the full build spec.

## Status: Phase 0 only

WellSky's real HTML markup (class names, how shift color/status is encoded) is unknown, so we
can't write a reliable parser yet — guessing at selectors would silently produce wrong or
missing data, which is worse than nothing for payroll accuracy.

This first pass is a **DOM discovery tool only**:

- **"Export Raw HTML"** — captures a best-guess schedule container from the active tab and
  downloads it as an `.html` file, so it can be inspected and pasted back into a Claude Code
  session to write the real parser.
- **"Scan Schedule"** — the real MVP feature. Disabled for now; comes in Phase 1+ once we've
  confirmed real markup.

Nothing in the extension runs automatically. It only reads the page when you click a button
in the popup.

## Loading the extension in Chrome

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked**.
4. Select the `extension/` folder from this repo.
5. The extension icon should now appear in your toolbar (you may need to pin it via the
   puzzle-piece icon).

## Using Phase 0 — capturing real WellSky markup

1. Log into WellSky and navigate to the schedule view.
2. Scroll/filter until you can see a shift you want to capture (e.g. a completed/green shift).
3. Click the extension icon, then click **Export Raw HTML**.
4. A `.html` file downloads (e.g. `wellsky-export-2026-07-26T18-05-00-000Z.html`). It contains
   a comment header (page URL, matched selector, timestamp) followed by the captured markup.
5. Repeat for each shift status we need to see real markup for:
   - Completed (green)
   - Incomplete (red)
   - Upcoming (blue)
   - Ongoing (yellow)
   - Cancelled (orange)
6. Bring the downloaded `.html` files (or their contents) back into a Claude Code session so
   the real Phase 1 parser can be written against confirmed selectors instead of guesses.

### If "Export Raw HTML" grabs the wrong thing

The content script (`extension/content-script.js`) tries a list of best-guess CSS selectors
(`[class*="schedule"]`, `[role="grid"]`, `table`, etc.) and falls back to the whole `<body>` if
none match. The downloaded file's comment header always says which selector actually matched —
if it's falling back to `document.body`, the file will be large but still usable: search it for
the shift you captured to find the real container by hand, and we'll add that selector to the
candidate list.

## What's not built yet

- Real shift parsing (Phase 1) — waiting on real markup from Phase 0.
- The "Scan Schedule" button and dedup logic (Phase 2).
- Google Sheet integration via Apps Script or n8n (Phase 3).

These will be added once Phase 0's captured markup confirms the real selectors and color/status
encoding. See `spec.md` for the full phased plan.

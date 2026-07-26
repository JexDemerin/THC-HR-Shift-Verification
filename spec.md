# WellSky Shift Scanner — MVP Build Spec
## Context
Together Homecare uses WellSky as our scheduling platform for caregivers. Shifts on the schedule are shown with color tags:
| Color  | Meaning              |
|--------|----------------------|
| Green  | Completed shift      |
| Red    | Incomplete logs (missing clock in/out) |
| Blue   | Upcoming shift       |
| Yellow | Ongoing shift        |
| Orange | Cancelled shift      |
WellSky doesn't export a usable report for payroll. We can see completed shifts, but we have no easy way to catch the **incomplete** ones — the ones where a caregiver forgot to clock in/out — so we can follow up with the client's family to verify actual hours before running payroll.
## Problem
No automated way to pull structured shift data (caregiver, client, date, time in/out, status) out of the WellSky schedule view, and no automatic flagging of incomplete shifts that need follow-up.
## What we're building (MVP scope)
A Chrome extension that:
1. Sits quietly until the user clicks a button — it never scans automatically.
2. Reads the currently visible WellSky schedule grid on-screen.
3. Extracts, per shift: caregiver name, client name, date, clock-in time, clock-out time, and status (from the color tag).
4. Sends that data to a Google Sheet, with incomplete (red) shifts clearly flagged for follow-up.
### Explicitly out of scope for this MVP
- No automatic/scheduled scanning — always user-triggered ("on my cue").
- No payroll or pay-rate calculations — just the shift list + flags.
- No auto-scrolling or auto-paging through multiple weeks/caregivers — user scans one visible screen at a time, and can click "Scan" again after scrolling/changing views.
- No mobile support.
## Important: Phase 0 must come first
Nobody currently knows WellSky's actual HTML structure (their page markup, class names, how color is encoded — inline style vs CSS class vs an icon/badge). We cannot write a reliable parser by guessing. So **before writing the real scanner**, Claude Code should build a small "Inspect Mode" to capture the real structure, so it can be examined and used to write the actual parsing logic.
Skipping this step and guessing at selectors will produce a scanner that looks like it works in testing but silently breaks or drops data in real use — which is worse than not having it at all, given this is used for payroll accuracy.
---
## Architecture
**Chrome extension (Manifest V3)**
- **Popup UI**: small window with two buttons —
  - `Export Raw HTML` (Phase 0 tool — see below)
  - `Scan Schedule` (the real MVP feature, built in Phase 1+)
  - A status/log area showing what was found (e.g., "42 shifts found — 3 flagged red")
- **Content script**: runs only when a popup button is clicked (never on page load automatically) — reads the DOM of the current WellSky tab.
- **Background/service worker**: takes the parsed shift data and sends it to the Google Sheet.
**Google Sheet as the destination**
- Simplest path: a **Google Apps Script Web App** tied to the target Sheet. The extension sends a POST request with the shift data as JSON; the Apps Script appends/updates rows.
- This avoids setting up Google OAuth consent screens inside the extension, and fits our existing Sheets-based infrastructure.
- *Alternative*: if preferred, this can instead POST to an n8n webhook (since we already run n8n) which writes to the Sheet. Flagging this as a swap-in option — default to the Apps Script route for MVP speed unless you'd rather route everything through n8n for consistency.
---
## Data model
Each scanned shift record:
| Field           | Example                  | Notes |
|-----------------|---------------------------|-------|
| caregiver_name  | "Amato, Savanna"          | |
| client_name     | "Joyner, Yusuf"            | |
| shift_date      | "2026-07-21"               | Normalize from column header (e.g. "7/21") using the visible year/month context |
| time_in         | "08:41"                    | 24hr internally; display however's clearest |
| time_out        | "18:00"                    | Blank/null if shift is incomplete or still ongoing |
| status          | "incomplete"                | enum: completed / incomplete / upcoming / ongoing / cancelled |
| status_raw      | e.g. class name or hex code | Keep this for debugging — lets us verify color→status mapping stayed correct |
| scanned_at      | timestamp of scan          | For dedup and audit trail |
---
## Phase 0 — DOM Discovery (build this first)
1. Add an "Export Raw HTML" button to the popup.
2. On click, the content script should locate the schedule grid container on the page (best guess to start, refine once we see real output) and grab its `outerHTML`.
3. Download it as a `.html` file (or copy to clipboard) so it can be opened and inspected, or pasted back into a Claude Code session to write the real parser against actual markup.
4. Do this for at least: a completed (green) shift, an incomplete (red) shift, an upcoming (blue) shift, an ongoing (yellow) shift, and a cancelled (orange) one — so the parser handles all five cases from real examples, not guesses.
**Output of this phase**: confirmed CSS selectors for the grid, shift cells, and however color/status is actually encoded (inline `style="background-color:..."`, a CSS class like `.shift-red`, or a separate badge/icon element).
---
## Phase 1 — Parsing logic
Once Phase 0 confirms the real markup, replace the placeholder parser with the real one.
Example input, per the pattern described:
```
Row: Amato, Savanna   8:41a-6p   Joyner, Yusuf
Column header: 7/21
```
→ Should parse to:
```
caregiver_name: Amato, Savanna
time_in: 8:41 AM
time_out: 6:00 PM
client_name: Joyner, Yusuf
shift_date: 7/21 (+ year from page context)
```
Notes/assumptions to verify during Phase 0:
- Is the order always `[caregiver] [time range] [client]`? If it can vary, the extension should log anything it can't confidently parse as "unparsed" rather than silently dropping it or guessing wrong — for payroll accuracy, a visible gap is much better than a wrong guess.
- Time format needs a regex tolerant of `8:41a`, `8:41am`, `8:41 AM`, etc.
- Color → status mapping table gets finalized with real values from Phase 0, e.g.:
  ```
  #2e7d32 or .shift-green  → completed
  #c62828 or .shift-red    → incomplete
  #1565c0 or .shift-blue   → upcoming
  #f9a825 or .shift-yellow → ongoing
  #ef6c00 or .shift-orange → cancelled
  ```
---
## Phase 2 — Trigger & scan behavior
- Trigger is the **popup's "Scan Schedule" button** only — nothing runs automatically on page load or on a timer. This matches "on my cue" and is also the safer choice re: WellSky's terms of use, since it's an explicit user action each time rather than passive background scraping.
- Scans only what's currently visible/rendered in the browser tab. If the user needs more data, they scroll or change the WellSky view and click "Scan" again.
- Dedup rule: when writing to the Sheet, use `(caregiver_name, client_name, shift_date)` as a unique key. Re-scanning the same shift should update its existing row (e.g. status changed from ongoing → completed) rather than create a duplicate.
---
## Phase 3 — Google Sheet integration
**Apps Script Web App (`Code.gs`)**
- `doPost(e)`: receives a JSON array of shift records.
- For each record: find existing row by the dedup key above; update it, or append a new row if not found.
- Set the `status` cell value; use conditional formatting already configured on the Sheet (or set directly via script) so incomplete/red rows are visually flagged — this is the main point of the whole tool, so it should be impossible to miss when scanning the sheet.
**Setup needed on your end (documented in README, not built by Claude Code):**
1. Create the destination Google Sheet with the column headers above.
2. Paste the generated `Code.gs` into Apps Script (Extensions → Apps Script) bound to that Sheet.
3. Deploy as Web App (execute as you, accessible to anyone with the link — or restrict as needed).
4. Copy the Web App URL into the extension's settings/config.
**Note on data sensitivity**: this data includes real client and caregiver names tied to care schedules. Keep the destination Sheet inside our Workspace domain (not a personal Google account), and restrict sharing/edit access to only the people who need it — consistent with how we've handled other PHI-adjacent data in our systems.
---
## Edge cases to handle explicitly
- Text that doesn't match the expected pattern → log as "unparsed," never silently drop.
- Ongoing (yellow) shifts have no end time yet — that's expected, not an error.
- Cancelled (orange) shifts — still record them, but they don't need clock-in verification/follow-up.
- Same caregiver, multiple shifts same day — must not collapse into one row.
- Overnight shifts (e.g. 10p–6a) — flag as a known limitation if the date-column logic doesn't cleanly handle a shift crossing midnight; confirm real behavior once we see actual WellSky data.
---
## Deliverables
- `/extension` — `manifest.json`, `popup.html`, `popup.js`, `content-script.js`, `background.js`
- `/apps-script` — `Code.gs` + deployment instructions
- `README.md` — plain-English instructions for loading the unpacked extension in Chrome (`chrome://extensions` → Developer Mode → Load unpacked) and deploying the Apps Script Web App
## Open questions to resolve during Phase 0 (don't guess — confirm from real markup)
- Exact selector for the schedule grid and individual shift cells
- Whether color is inline style, CSS class, or a separate badge element
- Exact date format used in column headers, and whether year is shown anywhere on screen
- Whether the `[caregiver] [time] [client]` order in the cell text is consistent across all shift types
---
## Suggested first message to Claude Code
> Read spec.md. Start with Phase 0 only: build the Chrome extension skeleton (Manifest V3) with a popup containing an "Export Raw HTML" button that captures the schedule grid's outerHTML from the active tab and downloads it. Don't build the real parser yet — we need real WellSky markup first before writing Phase 1.

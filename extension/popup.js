const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const exportBtn = document.getElementById('exportBtn');
const scanBtn = document.getElementById('scanBtn');
const webhookInput = document.getElementById('webhookUrl');
const saveWebhookBtn = document.getElementById('saveWebhookBtn');

function setStatus(text) {
  statusEl.textContent = text;
}

function addLogEntry(text) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = text;
  logEl.prepend(entry);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---- Export Raw HTML (Phase 0 debugging tool) ----

function buildExportDocument(result) {
  const header =
    `<!--\n` +
    `WellSky Raw HTML Export (Phase 0 — DOM discovery)\n` +
    `Page URL: ${result.pageUrl}\n` +
    `Page title: ${result.pageTitle}\n` +
    `Matched selector: ${result.matchedSelector}\n` +
    `Captured at: ${result.capturedAt}\n` +
    `-->\n`;
  return header + result.outerHTML;
}

function downloadHtmlExport(result) {
  const doc = buildExportDocument(result);
  const blob = new Blob([doc], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const safeTimestamp = result.capturedAt.replace(/[:.]/g, '-');
  const filename = `wellsky-export-${safeTimestamp}.html`;

  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  });
}

async function exportRawHtml() {
  exportBtn.disabled = true;
  setStatus('Reading current tab...');

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus('No active tab found.');
      return;
    }

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content-script.js'],
    });

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;
    if (!result || !result.outerHTML) {
      setStatus('Could not read any content from this page.');
      return;
    }

    downloadHtmlExport(result);

    const sizeKb = Math.round(result.byteLength / 1024);
    setStatus(`Captured ~${sizeKb} KB via "${result.matchedSelector}". Downloaded.`);
    addLogEntry(`${new Date(result.capturedAt).toLocaleTimeString()} — export — ${sizeKb} KB — ${result.matchedSelector}`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    exportBtn.disabled = false;
  }
}

// ---- Scan Schedule (the real feature) ----

async function scanSchedule() {
  scanBtn.disabled = true;
  setStatus('Scanning visible schedule...');

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus('No active tab found.');
      return;
    }

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['scan-script.js'],
    });

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;
    if (!result) {
      setStatus('Could not read the schedule from this page.');
      return;
    }

    const { records, summary } = result;

    if (summary.total === 0) {
      setStatus(`No shifts found (checked ${result.rowCount} caregiver rows). Is a schedule visible on screen?`);
      return;
    }

    const parts = [`${summary.total} shifts found`];
    if (summary.incomplete > 0) parts.push(`${summary.incomplete} flagged incomplete`);
    if (summary.unparsed > 0) parts.push(`${summary.unparsed} unparsed`);
    setStatus(parts.join(' — '));
    addLogEntry(
      `${new Date(result.scannedAt).toLocaleTimeString()} — scan — ${summary.total} total, ` +
        `${summary.completed} completed, ${summary.incomplete} incomplete, ${summary.upcoming} upcoming, ` +
        `${summary.ongoing} ongoing, ${summary.cancelled} cancelled, ${summary.unparsed} unparsed`
    );

    const { webhookUrl } = await chrome.storage.local.get('webhookUrl');
    if (!webhookUrl) {
      addLogEntry('Not sent — no Google Sheet URL saved yet (see Settings below).');
      return;
    }

    setStatus(parts.join(' — ') + ' — sending to sheet...');
    const response = await chrome.runtime.sendMessage({
      type: 'SEND_TO_SHEET',
      webhookUrl,
      records,
    });

    // response.ok is just the background worker's fetch succeeding — Apps
    // Script always answers with HTTP 200 even when its own code threw, so
    // the real pass/fail lives one level down in result.ok.
    const sheetResult = response && response.result;
    if (response && response.ok && sheetResult && sheetResult.ok) {
      setStatus(parts.join(' — ') + ' — sent to sheet.');
      addLogEntry('Sent to Google Sheet successfully.');
      logPivotSummary(sheetResult.pivotSummary);
    } else {
      const errorMessage =
        (sheetResult && sheetResult.error) ||
        (response && response.error) ||
        'unknown error — check the Apps Script project\'s Executions log (clock icon on the left) for the actual failure';
      setStatus(parts.join(' — ') + ` — send failed: ${errorMessage}`);
      addLogEntry(`Send to sheet failed: ${errorMessage}`);
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    scanBtn.disabled = false;
  }
}

// Surfaces what the Sheet-side script's timesheet lookup actually did, since
// a "sent successfully" HTTP response says nothing about whether any cells
// in the real timesheets tab were found and written — this is the only way
// to tell a shift landed vs. got silently skipped (no matching date column
// or caregiver row yet) without opening the sheet itself.
function logPivotSummary(summary) {
  if (!summary) return;

  if (summary.error) {
    addLogEntry(`Timesheet lookup error: ${summary.error}`);
    return;
  }

  addLogEntry(
    `Timesheet: ${summary.headerBlocksFound} date block(s) found in the sheet, ` +
      `${summary.written}/${summary.cellsResolved} cell(s) written.`
  );

  if (summary.skippedNoDateMatch && summary.skippedNoDateMatch.length > 0) {
    addLogEntry(`No matching date column yet for: ${summary.skippedNoDateMatch.join(', ')}`);
  }
  if (summary.skippedNoCaregiverMatch && summary.skippedNoCaregiverMatch.length > 0) {
    addLogEntry(`No matching caregiver row for: ${summary.skippedNoCaregiverMatch.join(', ')}`);
  }
}

// ---- Settings ----

async function loadWebhookUrl() {
  const { webhookUrl } = await chrome.storage.local.get('webhookUrl');
  if (webhookUrl) {
    webhookInput.value = webhookUrl;
  }
}

async function saveWebhookUrl() {
  const url = webhookInput.value.trim();
  if (!url) {
    setStatus('Enter a Google Sheet Web App URL first.');
    return;
  }

  try {
    new URL(url);
  } catch (err) {
    setStatus('That does not look like a valid URL.');
    return;
  }

  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
    setStatus('This should be an Apps Script Web App URL (starts with https://script.google.com/).');
    return;
  }

  saveWebhookBtn.disabled = true;
  try {
    await chrome.storage.local.set({ webhookUrl: url });
    setStatus('Google Sheet URL saved.');
  } catch (err) {
    setStatus(`Error saving URL: ${err.message}`);
  } finally {
    saveWebhookBtn.disabled = false;
  }
}

exportBtn.addEventListener('click', exportRawHtml);
scanBtn.addEventListener('click', scanSchedule);
saveWebhookBtn.addEventListener('click', saveWebhookUrl);
loadWebhookUrl();

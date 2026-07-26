const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const exportBtn = document.getElementById('exportBtn');

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

function downloadResult(result) {
  const doc = buildExportDocument(result);
  const blob = new Blob([doc], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const safeTimestamp = result.capturedAt.replace(/[:.]/g, '-');
  const filename = `wellsky-export-${safeTimestamp}.html`;

  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    // Give the browser a moment to start reading the blob before revoking.
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

    downloadResult(result);

    const sizeKb = Math.round(result.byteLength / 1024);
    setStatus(`Captured ~${sizeKb} KB via "${result.matchedSelector}". Downloaded.`);
    addLogEntry(`${new Date(result.capturedAt).toLocaleTimeString()} — ${sizeKb} KB — ${result.matchedSelector}`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    exportBtn.disabled = false;
  }
}

exportBtn.addEventListener('click', exportRawHtml);

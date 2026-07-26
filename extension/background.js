// Service worker for the THC WellSky Shift Scanner extension.
//
// The popup does the scanning; this worker's only job is relaying the
// resulting shift records to the configured Google Sheet Web App (or n8n
// webhook), since fetches to an external URL belong in the background
// context rather than the popup.

chrome.runtime.onInstalled.addListener(() => {
  console.log('THC WellSky Shift Scanner installed.');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'SEND_TO_SHEET') {
    sendToSheet(message.webhookUrl, message.records)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }
});

async function sendToSheet(webhookUrl, records) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    // text/plain avoids a CORS preflight request, which Apps Script Web
    // Apps don't answer correctly — Apps Script still reads the body as
    // JSON on its end regardless of this header.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(records),
  });

  if (!response.ok) {
    throw new Error(`Sheet responded with HTTP ${response.status}`);
  }

  return response.json().catch(() => ({}));
}

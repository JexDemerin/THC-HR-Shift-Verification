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

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Sheet responded with HTTP ${response.status}: ${plainTextSnippet(text)}`);
  }

  // A non-JSON 200 (e.g. Apps Script's own "authorization required" or
  // uncaught-exception HTML page) used to get silently swallowed into {},
  // which is how a real failure turned into a content-free "unknown error"
  // upstream — surface the actual body instead.
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Sheet response wasn't valid JSON: ${plainTextSnippet(text)}`);
  }
}

// Apps Script's own error pages are HTML with a big inline <style> block
// before the actual message — a plain character-count slice of the raw
// markup mostly just shows CSS. Stripping tags first means the same
// snippet length actually shows the error text itself.
function plainTextSnippet(html, maxLength = 500) {
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

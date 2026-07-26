// Service worker for the THC WellSky Shift Scanner extension.
//
// Phase 0 doesn't need a background worker at all — the popup injects
// content-script.js directly and downloads the result itself. This file
// is a placeholder for Phase 2/3, when "Scan Schedule" needs to send
// parsed shift records to the Google Sheet (Apps Script Web App or n8n
// webhook) from a persistent context.

chrome.runtime.onInstalled.addListener(() => {
  console.log('THC WellSky Shift Scanner installed.');
});

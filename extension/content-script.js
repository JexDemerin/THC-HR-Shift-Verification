// Phase 0 — DOM Discovery
//
// We don't yet know WellSky's real markup (class names, whether color is an
// inline style, a CSS class, or a badge element). This script does NOT try
// to parse shifts. It just finds a plausible schedule container, grabs its
// outerHTML, and hands it back to the popup so a human can inspect it and
// Claude Code can write the real Phase 1 parser against real markup.
//
// This file only ever runs when injected on demand from popup.js in
// response to a user clicking "Export Raw HTML" — never on page load.

(function () {
  function findScheduleContainer() {
    // Ordered best guesses, most-specific first. None of these are
    // confirmed — Phase 0's whole job is to tell us which one (if any)
    // was right, or that we need a different selector entirely.
    const candidateSelectors = [
      '[class*="schedule-grid" i]',
      '[class*="scheduleGrid" i]',
      '[class*="calendar-grid" i]',
      '[class*="schedule" i][class*="grid" i]',
      '[data-testid*="schedule" i]',
      '[role="grid"]',
      '[class*="schedule" i]',
      '[class*="calendar" i]',
      '[id*="schedule" i]',
      '[id*="calendar" i]',
      'table',
    ];

    for (const selector of candidateSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          return { element: el, selector };
        }
      } catch (err) {
        // Invalid selector in this browser/DOM shape — skip it.
      }
    }

    return {
      element: document.body,
      selector: 'document.body (fallback — no schedule container matched any candidate selector)',
    };
  }

  const { element, selector } = findScheduleContainer();
  const outerHTML = element.outerHTML || '';

  return {
    matchedSelector: selector,
    outerHTML,
    byteLength: outerHTML.length,
    pageUrl: window.location.href,
    pageTitle: document.title,
    capturedAt: new Date().toISOString(),
  };
})();

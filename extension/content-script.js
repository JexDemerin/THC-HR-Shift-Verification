// Phase 0 — DOM Discovery
//
// We don't yet know WellSky's real markup (class names, whether color is an
// inline style, a CSS class, or a badge element). This script does NOT try
// to parse shifts. It just finds the schedule grid, grabs its outerHTML, and
// hands it back to the popup so a human can inspect it and Claude Code can
// write the real Phase 1 parser against real markup.
//
// This file only ever runs when injected on demand from popup.js in
// response to a user clicking "Export Raw HTML" — never on page load.
//
// First attempt used guessed class-name selectors (e.g. [class*="schedule"])
// and that matched a tiny unrelated legend label ("Scheduled") instead of the
// actual grid, because WellSky happens to use that word in more than one
// place. Guessing selectors clearly isn't reliable here, so instead we look
// for the container that actually holds the shift data: the smallest element
// on the page whose text contains a lot of shift-time-looking patterns
// (e.g. "8:41a", "6p", "10a-6p"). That's a much stronger signal than a class
// name, since it's tied to the real content we're trying to capture.

(function () {
  const TIME_PATTERN = /\b\d{1,2}(:\d{2})?\s*[ap]\.?m?\.?\b/gi;
  const MIN_TIME_MATCHES = 8; // a real schedule grid should have many shift times in it
  const CONTAINER_TAGS = new Set([
    'DIV', 'TABLE', 'TBODY', 'SECTION', 'MAIN', 'ARTICLE', 'UL', 'OL', 'FORM',
  ]);

  function countTimeMatches(text) {
    const matches = text.match(TIME_PATTERN);
    return matches ? matches.length : 0;
  }

  // Find the smallest container-like element whose text contains at least
  // MIN_TIME_MATCHES shift-time patterns. "Smallest" means the tightest
  // wrapper around the actual grid, not the whole page.
  function findByTimeDensity() {
    const candidates = document.body
      ? Array.from(document.body.querySelectorAll('*')).filter((el) => CONTAINER_TAGS.has(el.tagName))
      : [];

    let best = null;
    let bestSize = Infinity;

    for (const el of candidates) {
      const count = countTimeMatches(el.textContent || '');
      if (count >= MIN_TIME_MATCHES) {
        const size = el.outerHTML.length;
        if (size < bestSize) {
          bestSize = size;
          best = el;
        }
      }
    }

    if (best) {
      return { element: best, selector: `content-match (${countTimeMatches(best.textContent)} shift-time patterns found inside <${best.tagName.toLowerCase()}>)` };
    }
    return null;
  }

  // Fallback guesses, only used if the content-based search above finds
  // nothing (e.g. no shift times are visible on the current view at all).
  function findByGuessedSelector() {
    const candidateSelectors = [
      '[class*="schedule-grid" i]',
      '[class*="scheduleGrid" i]',
      '[class*="calendar-grid" i]',
      '[role="grid"]',
      'table',
      '[class*="schedule" i]',
      '[class*="calendar" i]',
    ];

    for (const selector of candidateSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          return { element: el, selector: `guessed selector: ${selector}` };
        }
      } catch (err) {
        // Invalid selector in this browser/DOM shape — skip it.
      }
    }
    return null;
  }

  const found =
    findByTimeDensity() ||
    findByGuessedSelector() || {
      element: document.body,
      selector: 'document.body (fallback — nothing else matched; search the file for a shift you can see on screen)',
    };

  const outerHTML = found.element.outerHTML || '';

  return {
    matchedSelector: found.selector,
    outerHTML,
    byteLength: outerHTML.length,
    pageUrl: window.location.href,
    pageTitle: document.title,
    capturedAt: new Date().toISOString(),
  };
})();

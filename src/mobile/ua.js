/**
 * Pure helpers for mobile user-agent detection and the redirect decision
 * between the desktop (`/`) and mobile (`/m/`) entry points.
 *
 * No DOM access, no navigator/window touching. Callers pass everything in,
 * which keeps this module testable in jsdom without globals leakage.
 *
 * iPad is intentionally treated as DESKTOP:
 *   - Modern iPadOS Safari reports a desktop UA by default, so any UA-based
 *     mobile detection misses it anyway.
 *   - The iPad screen has the real estate to run the desktop UX, including
 *     Schedule Manager and Configuration tabs that don't fit on phones.
 *   - Users who explicitly want the mobile view can visit `/m/` directly.
 */

const MOBILE_UA_PATTERN = /Mobi|Android|iPhone|iPod/i;
// iPad UA strings contain the substring "Mobile/15E148" which would
// otherwise match the pattern above; explicitly exclude iPads so they
// keep the desktop UX (plenty of screen real estate).
const IPAD_PATTERN = /iPad/;

/**
 * @param {string|undefined|null} ua - navigator.userAgent value
 * @returns {boolean} true if the UA looks like a phone (not tablet/desktop).
 */
export function isMobileUA(ua) {
  if (!ua || typeof ua !== 'string') return false;
  if (IPAD_PATTERN.test(ua)) return false;
  return MOBILE_UA_PATTERN.test(ua);
}

/**
 * Decide whether the current page load should bounce to the mobile entry.
 *
 * @param {object} input
 * @param {string} input.pathname - location.pathname
 * @param {string} input.search   - location.search (incl. leading '?')
 * @param {Storage} input.sessionStorage - sessionStorage (or stub)
 * @param {string} input.userAgent - navigator.userAgent
 * @returns {{ redirect: boolean, target?: string }}
 *   target is a path RELATIVE to the current page, so the caller can call
 *   `location.replace(target)` and end up at the correct sub-path on GitHub
 *   Pages (`/tle_orbit_visualizer/m/`) without hard-coding the prefix.
 */
export function shouldRedirectToMobile({ pathname, search, sessionStorage, userAgent }) {
  // Honour the user's escape hatch first.
  try {
    if (sessionStorage && sessionStorage.getItem('forceDesktop') === '1') {
      return { redirect: false };
    }
  } catch (_) {
    // sessionStorage denied (privacy mode etc.) — proceed with UA test.
  }

  if (!isMobileUA(userAgent)) return { redirect: false };

  // Already on a mobile entry — no loop.
  if (/(^|\/)m\/(index\.html)?$/.test(pathname || '')) {
    return { redirect: false };
  }

  return {
    redirect: true,
    target: 'm/' + (search || ''),
  };
}

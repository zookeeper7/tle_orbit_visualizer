/**
 * Internet connectivity check, live GP/OMM fetching, and satellite search from
 * CelesTrak.
 *
 * CelesTrak GP API (OMM is the forward-compatible format — `FORMAT=TLE` cannot
 * return 6+ digit catalog numbers once the 5-digit space runs out ~2026):
 *   https://celestrak.org/NORAD/elements/gp.php?CATNR={noradId}&FORMAT=JSON
 *   https://celestrak.org/NORAD/elements/gp.php?NAME={query}&FORMAT=JSON
 *
 * `fetchGP` returns the raw OMM record. `fetchLatestTLE` is a backward-compatible
 * shim that converts that OMM into the legacy 3-line TLE string the rest of the
 * app already consumes. All fetches are gated by a 2-hour client cache and raise
 * a typed `CelestrakError` (with `.status` / `.isRateLimited`) so batch callers
 * can stop on a rate-limit instead of hammering CelesTrak into a firewall block.
 */

import { ommToTLE, CelestrakError } from './gp.js';
import { getCachedGP, setCachedGP } from './core/celestrak-cache.js';

// Canonical HTTPS .org host — the .com host answers with HTTP 301, which counts
// against CelesTrak's rate-limit/firewall policy.
const CELESTRAK_BASE = 'https://celestrak.org/NORAD/elements/gp.php';

function celestrakStatusMessage(status, noradId) {
  if (status === 403) {
    return 'CelesTrak rate limit reached (HTTP 403). GP data only updates every 2 hours — wait before retrying.';
  }
  if (status === 404) return `No GP data found for NORAD ID ${noradId} (HTTP 404).`;
  if (status === 301) return 'CelesTrak redirected the request (HTTP 301) — use the https://celestrak.org host.';
  return `CelesTrak returned HTTP ${status}.`;
}

/** Wire an optional external AbortSignal into a fresh timeout-based controller. */
function makeController(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return { controller, timeoutId };
}

/**
 * Check internet connectivity by hitting CelesTrak's GP endpoint.
 *
 * Uses GET (not HEAD) because CelesTrak's CORS config doesn't allow HEAD from
 * the browser. CATNR=25544 (ISS) is a permanent 5-digit object, so this ping is
 * stable. This is a live request (not cache-gated) because it must reflect real
 * connectivity.
 * @returns {Promise<boolean>}
 */
export async function checkConnection() {
  const { controller, timeoutId } = makeController(5000);
  try {
    const response = await fetch(`${CELESTRAK_BASE}?CATNR=25544&FORMAT=JSON`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

/**
 * Fetch a single satellite's GP data as a CCSDS OMM record.
 *
 * Served from the 2-hour client cache when a fresh record exists (respecting
 * CelesTrak's update cadence); otherwise fetched live and cached.
 *
 * @param {number} noradId - NORAD catalog number (1–9 digits)
 * @param {{ force?: boolean, signal?: AbortSignal }} [opts] - force bypasses the cache
 * @returns {Promise<Record<string, unknown>>} the OMM record
 * @throws {CelestrakError} network/HTTP/parse failure (carries .status)
 */
export async function fetchGP(noradId, opts = {}) {
  const id = Number(noradId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new CelestrakError(`Invalid NORAD ID: ${noradId}`);
  }

  if (!opts.force) {
    const cached = getCachedGP(id);
    if (cached) return cached;
  }

  const { controller, timeoutId } = makeController(10000, opts.signal);
  let response;
  try {
    response = await fetch(`${CELESTRAK_BASE}?CATNR=${id}&FORMAT=JSON`, {
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err && err.name === 'AbortError') {
      throw new CelestrakError('Request timed out — check your internet connection.', { cause: err });
    }
    // Browser CORS/network failures are opaque (no readable status).
    throw new CelestrakError(`Network error: ${err && err.message ? err.message : err}`, { cause: err });
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new CelestrakError(celestrakStatusMessage(response.status, id), { status: response.status });
  }

  const text = (await response.text()).trim();
  if (!text || text.startsWith('No GP') || text === '[]') {
    throw new CelestrakError(`No GP data found for NORAD ID ${id}.`, { status: 404 });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new CelestrakError('Invalid JSON response from CelesTrak.', { cause: err });
  }

  const omm = Array.isArray(data) ? data[0] : data;
  if (!omm || typeof omm !== 'object' || omm.NORAD_CAT_ID == null) {
    throw new CelestrakError(`No GP data found for NORAD ID ${id}.`, { status: 404 });
  }

  setCachedGP(id, omm);
  return omm;
}

/**
 * Fetch the latest TLE for a satellite from CelesTrak.
 *
 * Backward-compatible shim: fetches OMM (future-proof) and converts it to the
 * legacy 3-line TLE string that the app's storage + SGP4 pipeline consume.
 * @param {number} noradId - NORAD catalog number
 * @param {{ force?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<string>} 3-line TLE string (name\nline1\nline2)
 * @throws {CelestrakError}
 */
export async function fetchLatestTLE(noradId, opts = {}) {
  const omm = await fetchGP(noradId, opts);
  return ommToTLE(omm).threeLine;
}

/**
 * Search satellites by name on CelesTrak (partial match). Returns OMM-derived
 * summaries. Not cache-gated (search queries vary and are user-driven).
 * @param {string} query
 * @returns {Promise<Array<{name:string, noradId:number, objectId:string, inclination?:number, period?:number|null}>>}
 * @throws {CelestrakError}
 */
export async function searchSatellitesByName(query) {
  if (!query || query.trim().length < 2) return [];

  const { controller, timeoutId } = makeController(10000);
  let response;
  try {
    response = await fetch(
      `${CELESTRAK_BASE}?NAME=${encodeURIComponent(query.trim())}&FORMAT=JSON`,
      { signal: controller.signal, cache: 'no-store' },
    );
  } catch (err) {
    clearTimeout(timeoutId);
    if (err && err.name === 'AbortError') throw new CelestrakError('Search timed out.', { cause: err });
    throw new CelestrakError(`Network error: ${err && err.message ? err.message : err}`, { cause: err });
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new CelestrakError(celestrakStatusMessage(response.status, query), { status: response.status });
  }

  const text = (await response.text()).trim();
  if (!text || text.startsWith('No GP')) return [];

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  return data.map(ommToSummary);
}

/**
 * Search satellites by NORAD catalog number on CelesTrak.
 * @param {number} noradId
 * @returns {Promise<Array<{name:string, noradId:number, objectId:string, inclination?:number, period?:number|null}>>}
 */
export async function searchSatellitesByNorad(noradId) {
  if (!Number.isFinite(noradId) || noradId <= 0) return [];

  const { controller, timeoutId } = makeController(10000);
  let response;
  try {
    response = await fetch(
      `${CELESTRAK_BASE}?CATNR=${noradId}&FORMAT=JSON`,
      { signal: controller.signal, cache: 'no-store' },
    );
  } catch (err) {
    clearTimeout(timeoutId);
    if (err && err.name === 'AbortError') throw new CelestrakError('Search timed out.', { cause: err });
    return [];
  }
  clearTimeout(timeoutId);

  if (!response.ok) return [];

  const text = (await response.text()).trim();
  if (!text || text.startsWith('No GP')) return [];

  let data;
  try { data = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(data)) return [];

  return data.map(ommToSummary);
}

/** Map a CelesTrak OMM record to the lightweight search-result summary. */
function ommToSummary(item) {
  return {
    name: item.OBJECT_NAME || '',
    noradId: item.NORAD_CAT_ID || 0,
    objectId: item.OBJECT_ID || '',
    inclination: item.INCLINATION,
    period: item.MEAN_MOTION ? (1440 / item.MEAN_MOTION) : null,
  };
}
